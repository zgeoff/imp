package session

import (
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/pty"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// historyLimit is the least output a session keeps for a replay. A session
// holds up to twice this in guest memory.
const historyLimit = 256 << 10

// drainGrace bounds how long output is read after the process exits, as in
// exec: a background child that keeps the pty open cannot hold the session.
const drainGrace = 500 * time.Millisecond

// stdinQueue bounds the STDIN frames waiting for the pty. Past it the
// viewer's input loop waits, which pushes back on the host.
const stdinQueue = 256

// session is one program on a pty that outlives its connections. One pump
// reads the pty into the screen and the attached viewer, if any; it never
// waits on a viewer.
type session struct {
	name    string
	argv    []string
	started time.Time
	proc    *proc.Process
	master  *os.File

	stdin chan []byte
	// done closes once the process exited and its output drained.
	done chan struct{}

	mu         sync.Mutex
	screen     Screen
	viewer     *viewer
	cols, rows uint16
	exit       *proto.Exit
	// delivered is set once a viewer got the EXIT; the session is then over.
	delivered bool
}

func newSession(name string, req proto.Request, p *proc.Process, master *os.File) *session {
	cols, rows := req.Cols, req.Rows
	if cols == 0 || rows == 0 {
		cols, rows = 80, 24
	}
	return &session{
		name:    name,
		argv:    req.Argv,
		started: time.Now(),
		proc:    p,
		master:  master,
		stdin:   make(chan []byte, stdinQueue),
		done:    make(chan struct{}),
		screen:  newHistory(historyLimit),
		cols:    cols,
		rows:    rows,
	}
}

// run pumps output until the process exits and its output drained, then
// hands the EXIT to the viewer, or keeps it for the next one. onExit runs
// after that.
func (s *session) run(onExit func()) {
	pumped := make(chan struct{})
	safe.Go("session "+s.name+" output", func() {
		defer close(pumped)
		s.pump()
	}, nil)
	safe.Go("session "+s.name+" stdin", s.writeStdin, nil)

	st := <-s.proc.Done
	s.master.SetReadDeadline(time.Now().Add(drainGrace))
	<-pumped
	s.master.Close()

	exit := proto.ExitOf(st.Code, int(st.Signal))
	s.mu.Lock()
	s.exit = &exit
	if s.viewer != nil {
		s.deliverExit(s.viewer)
	}
	s.mu.Unlock()
	close(s.done)
	onExit()
}

// pump reads the pty until EOF, EIO (every slave fd closed), or the drain
// deadline.
func (s *session) pump() {
	buf := make([]byte, 32<<10)
	for {
		n, err := s.master.Read(buf)
		if n > 0 {
			s.output(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func (s *session) output(p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.screen.Write(p)
	if v := s.viewer; v != nil && !v.push(frame{proto.TypeStdout, append([]byte(nil), p...)}) {
		s.viewer = nil
		v.stop(&frame{proto.TypeDetached, mustJSON(proto.Detached{Reason: proto.DetachSlow})}, true)
	}
}

// attach makes v the viewer: STARTED, the replay, then live output. A viewer
// already attached is detached first. It returns false when the session is
// already over.
func (s *session) attach(v *viewer, cols, rows uint16, created bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.delivered {
		return false
	}
	if old := s.viewer; old != nil {
		old.stop(&frame{proto.TypeDetached, mustJSON(proto.Detached{Reason: proto.DetachTakenOver})}, false)
	}
	v.pushJSON(proto.TypeStarted, proto.Started{Pid: s.proc.Pid, Session: s.name, Created: created})
	if replay := s.screen.Replay(); len(replay) > 0 {
		v.push(frame{proto.TypeStdout, replay})
	}
	if s.exit != nil {
		s.deliverExit(v)
		return true
	}
	s.viewer = v
	if !created {
		s.redraw(cols, rows)
	}
	return true
}

// redraw sizes the pty for a new viewer. The kernel sends SIGWINCH only for
// a new size, so a viewer of the same size first gets one row less: either
// way the program sees a resize and draws its screen again.
func (s *session) redraw(cols, rows uint16) {
	if cols == 0 || rows == 0 {
		return
	}
	if cols == s.cols && rows == s.rows && rows > 1 {
		pty.SetWinsize(s.master, cols, rows-1)
	}
	s.resizeLocked(cols, rows)
}

func (s *session) resize(v *viewer, cols, rows uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.viewer == v && cols > 0 && rows > 0 {
		s.resizeLocked(cols, rows)
	}
}

func (s *session) resizeLocked(cols, rows uint16) {
	if s.exit != nil {
		return
	}
	pty.SetWinsize(s.master, cols, rows)
	s.cols, s.rows = cols, rows
}

// deliverExit ends the session with v as the viewer that sees the EXIT. The
// caller holds mu.
func (s *session) deliverExit(v *viewer) {
	s.viewer = nil
	s.delivered = true
	v.stop(&frame{proto.TypeExit, mustJSON(*s.exit)}, false)
}

// detach drops v if it is still the viewer. The process keeps running.
func (s *session) detach(v *viewer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.viewer == v {
		s.viewer = nil
	}
	v.stop(nil, false)
}

func (s *session) signal(v *viewer, sig syscall.Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.viewer == v && s.exit == nil {
		s.proc.Signal(sig)
	}
}

// queueStdin hands p to the stdin writer. It waits while the queue is full,
// and gives up once the viewer or the session ends.
func (s *session) queueStdin(v *viewer, p []byte) {
	select {
	case s.stdin <- p:
	case <-v.done:
	case <-s.done:
	}
}

// writeStdin writes queued input to the pty until the session ends. A write
// the program never reads waits on the pty, not on any viewer.
func (s *session) writeStdin() {
	for {
		select {
		case p := <-s.stdin:
			s.master.Write(p)
		case <-s.done:
			return
		}
	}
}

func (s *session) info() proto.SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	info := proto.SessionInfo{
		Name:          s.name,
		Pid:           s.proc.Pid,
		Argv:          s.argv,
		State:         proto.SessionRunning,
		Attached:      s.viewer != nil,
		Cols:          s.cols,
		Rows:          s.rows,
		StartedUnixMs: s.started.UnixMilli(),
		Exit:          s.exit,
	}
	if s.exit != nil {
		info.State = proto.SessionExited
	}
	return info
}

// exited reports whether the process exited: a new session may then take
// the name.
func (s *session) exited() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exit != nil
}

// over reports whether a viewer got the EXIT: nothing is left to attach to.
func (s *session) over() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.delivered
}
