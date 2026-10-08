package session

import (
	"errors"
	"fmt"
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

// tapWait bounds how long a logged session's output waits for a tap
// before the ring overwrites bytes no tap took: past it the session runs on,
// and the bytes the ring drops are a gap in impd's log. A variable so tests
// can shorten it.
var tapWait = 5 * time.Second

// readSize is one read of the pty.
const readSize = 32 << 10

// stdinQueue bounds the STDIN frames waiting for the pty, at most
// proto.MaxPayload each. Past it the viewer's input loop waits, which pushes
// back on the host.
const stdinQueue = 4

// errOver is attach's answer once a viewer got the EXIT: nothing is left to
// attach to.
var errOver = errors.New("the session is over")

// session is one program on a pty that outlives its connections. One pump
// reads the pty into the screen, the raw ring, the attached viewer, if any,
// and impd's taps of a logged session; it never waits on any of them.
type session struct {
	name    string
	argv    []string
	started time.Time
	proc    *proc.Process
	master  *os.File

	// generation names this run of the process; seq orders the runs of
	// every name in this boot
	generation string
	seq        uint64
	bootID     string
	// log marks a session whose output impd keeps; only it takes taps
	log bool

	stdin chan []byte
	// done closes once the process exited and its output drained.
	done chan struct{}

	mu     sync.Mutex
	screen Screen
	// raw is the output a resume reads; its end is the session's offset
	raw    *ring
	viewer *viewer
	// taps read the raw output beside the viewer: they take no input, never
	// take the viewer over, and get the EXIT without delivering it. tapStart
	// is the offset each began at; tapped the furthest offset a tap wrote out.
	taps     map[*viewer]struct{}
	tapStart map[*viewer]uint64
	tapped   uint64
	// tapless is set once a pump gave up waiting for a tap, until one attaches
	tapless bool
	// heldForTap is set while the pump holds its next read for a tap, so a
	// caller can see the hold rather than guess when it began
	heldForTap bool
	// tapProgress wakes a waiting pump when a tap wrote output out
	tapProgress chan struct{}
	// tapWait is the package's, as the session started
	tapWait    time.Duration
	cols, rows uint16
	exit       *proto.Exit
	// delivered is set once the EXIT was written to a viewer; the session is
	// then over. Until then each new viewer gets the EXIT.
	delivered bool
	// onDelivered runs once delivered is set.
	onDelivered func()
}

// run is what makes a session: its process, and where it stands among the
// runs of this boot.
type run struct {
	proc       *proc.Process
	master     *os.File
	generation string
	seq        uint64
	bootID     string
}

func newSession(name string, req proto.Request, r run) *session {
	cols, rows := req.Cols, req.Rows
	if cols == 0 || rows == 0 {
		cols, rows = 80, 24
	}
	return &session{
		name:        name,
		argv:        req.Argv,
		started:     time.Now(),
		proc:        r.proc,
		master:      r.master,
		generation:  r.generation,
		seq:         r.seq,
		bootID:      r.bootID,
		log:         req.Log,
		stdin:       make(chan []byte, stdinQueue),
		done:        make(chan struct{}),
		screen:      newHistory(historyLimit),
		raw:         newRing(ringSize),
		taps:        make(map[*viewer]struct{}),
		tapStart:    make(map[*viewer]uint64),
		tapWait:     tapWait,
		tapProgress: make(chan struct{}, 1),
		cols:        cols,
		rows:        rows,
	}
}

// run pumps output until the process exits and its output drained, then
// hands the EXIT to the viewer, or keeps it for the next one.
func (s *session) run() {
	pumped := make(chan struct{})
	safe.Go("session "+s.name+" output", func() {
		defer close(pumped)
		s.pump()
	}, nil)
	safe.Go("session "+s.name+" stdin", s.writeStdin, nil)

	st := <-s.proc.Done
	// a logged session's pump may be waiting for its tap
	grace := drainGrace
	if s.log {
		grace += s.tapWait
	}
	s.master.SetReadDeadline(time.Now().Add(grace))
	<-pumped
	s.master.Close()

	exit := proto.ExitOf(st.Code, int(st.Signal))
	s.mu.Lock()
	s.exit = &exit
	if s.viewer != nil {
		s.deliverExit(s.viewer)
	}
	for t := range s.taps {
		s.dropTap(t)
		t.stop(s.exitFrame(nil), false)
	}
	s.mu.Unlock()
	close(s.done)
}

// pump reads the pty until EOF, EIO (every slave fd closed), or the drain
// deadline.
func (s *session) pump() {
	buf := make([]byte, readSize)
	for {
		s.waitForTap()
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
	s.raw.Write(p)
	if v := s.viewer; v != nil && !v.push(frame{typ: proto.TypeStdout, payload: append([]byte(nil), p...)}) {
		s.viewer = nil
		v.stop(&frame{typ: proto.TypeDetached, payload: mustJSON(proto.Detached{Reason: proto.DetachSlow})}, true)
	}
	// a tap that falls behind is dropped the same way: impd taps again from
	// the offset it has, and learns of the gap from the ring
	for t := range s.taps {
		if !t.push(frame{typ: proto.TypeStdout, payload: append([]byte(nil), p...)}) {
			s.dropTap(t)
			t.stop(&frame{typ: proto.TypeDetached, payload: mustJSON(proto.Detached{Reason: proto.DetachSlow})}, true)
		}
	}
}

// waitForTap holds a logged session's next read while it could overwrite
// ring bytes that no tap wrote out, so impd's log misses nothing it taps in
// time: the program waits on the pty as on a slow terminal. Each call waits
// at most tapWait from its start, and tap progress does not extend it. Once
// a call runs out, the session reads on, unheld, until a tap attaches.
func (s *session) waitForTap() {
	if !s.log {
		return
	}
	deadline := time.NewTimer(s.tapWait)
	defer deadline.Stop()
	expired := false
	for {
		s.mu.Lock()
		if s.untapped()+readSize <= ringSize || s.tapless {
			s.heldForTap = false
			s.mu.Unlock()
			return
		}
		if expired {
			s.tapless = true
			s.heldForTap = false
			s.mu.Unlock()
			return
		}
		s.heldForTap = true
		s.mu.Unlock()
		select {
		case <-s.tapProgress:
		case <-deadline.C:
			expired = true
		}
	}
}

// untapped counts the bytes past the furthest offset a tap wrote out. The
// caller holds mu.
func (s *session) untapped() uint64 {
	for t := range s.taps {
		s.tapped = max(s.tapped, s.tapStart[t]+t.written.Load())
	}
	return s.raw.End() - s.tapped
}

// tap adds t as a tap of a logged session: STARTED, the raw output from
// resume (from the ring's start without it), then live output and the
// EXIT. It never replays the screen or touches the viewer. It returns a
// *proto.Error, and t got nothing, for a session with no log or a resume
// past the end.
func (s *session) tap(t *viewer, resume *proto.ResumeFrom) *proto.Error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.log {
		return &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("session %q keeps no log", s.name)}
	}
	out, data := s.outputNow(), []byte(nil)
	if resume == nil {
		out.Offset = out.BufferStart
		data = s.raw.From(out.Offset)
	} else {
		var err error
		if out, data, err = s.place(resume); err != nil {
			return err.(*proto.Error)
		}
	}
	t.pushJSON(proto.TypeStarted, proto.Started{Pid: s.proc.Pid, Session: s.name, Output: &out})
	if len(data) > 0 {
		t.push(frame{typ: proto.TypeStdout, payload: data})
	}
	if s.exit != nil {
		t.stop(s.exitFrame(nil), false)
		return nil
	}
	s.taps[t] = struct{}{}
	s.tapStart[t] = out.Offset
	s.tapless = false
	return nil
}

// untap drops t if it still taps the session.
func (s *session) untap(t *viewer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropTap(t)
	t.stop(nil, false)
}

// dropTap removes t, keeping how far it read. The caller holds mu.
func (s *session) dropTap(t *viewer) {
	if start, ok := s.tapStart[t]; ok {
		s.tapped = max(s.tapped, start+t.written.Load())
	}
	delete(s.taps, t)
	delete(s.tapStart, t)
}

// exitFrame is the EXIT as a last frame; written runs once it is out. The
// caller holds mu, and exit is set.
func (s *session) exitFrame(written func()) *frame {
	return &frame{typ: proto.TypeExit, payload: mustJSON(*s.exit), written: written}
}

// attach makes v the viewer: STARTED, the output that resume asks for (a
// replay without it), then live output. A viewer already attached is
// detached first. It returns errOver when the session is already over, and
// a *proto.Error for a resume past the end; v then got nothing.
func (s *session) attach(v *viewer, cols, rows uint16, created bool, resume *proto.ResumeFrom, previous *proto.Previous) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.delivered {
		return errOver
	}
	out, data, err := s.place(resume)
	if err != nil {
		return err
	}
	out.Previous = previous
	if old := s.viewer; old != nil {
		old.stop(&frame{typ: proto.TypeDetached, payload: mustJSON(proto.Detached{Reason: proto.DetachTakenOver})}, false)
	}
	v.pushJSON(proto.TypeStarted, proto.Started{Pid: s.proc.Pid, Session: s.name, Created: created, Output: &out})
	if len(data) > 0 {
		v.push(frame{typ: proto.TypeStdout, payload: data})
	}
	if s.exit != nil {
		s.deliverExit(v)
		return nil
	}
	s.viewer = v
	switch {
	case created:
	case resume == nil:
		s.redraw(cols, rows)
	case cols > 0 && rows > 0 && (cols != s.cols || rows != s.rows):
		// a resume continues the output as it was: no forced redraw, only
		// the viewer's size
		s.resizeLocked(cols, rows)
	}
	return nil
}

// place finds where a connection's data starts, and the data up to now: a
// fresh attach replays the history, its prelude first; a resume reads the
// raw ring. The caller holds mu.
func (s *session) place(resume *proto.ResumeFrom) (proto.Output, []byte, error) {
	out := s.outputNow()
	start, end := out.BufferStart, out.End
	switch {
	case resume == nil:
		prelude, kept := s.screen.Replay()
		out.Offset = end - uint64(len(kept))
		out.Prelude = len(prelude)
		return out, append(append(make([]byte, 0, len(prelude)+len(kept)), prelude...), kept...), nil
	case resume.Generation != s.generation:
		out.Resume = &proto.Resume{Kind: proto.ResumeGenerationChanged, Generation: s.generation, FirstOffset: &start}
		out.Offset = start
	case resume.Offset > end:
		return out, nil, &proto.Error{
			Code:    proto.ErrInvalidResume,
			Message: fmt.Sprintf("offset %d is past the end of the output, %d", resume.Offset, end),
			Data:    proto.InvalidResumeData{End: end, BufferStart: start},
		}
	case resume.Offset >= start:
		out.Resume = &proto.Resume{Kind: proto.ResumeExact}
		out.Offset = resume.Offset
	default:
		out.Resume = &proto.Resume{Kind: proto.ResumeGap, From: &resume.Offset, To: &start}
		out.Offset = start
	}
	return out, s.raw.From(out.Offset), nil
}

// outputNow is where the output stands, before a connection's place in it.
// The caller holds mu.
func (s *session) outputNow() proto.Output {
	return proto.Output{BootID: s.bootID, Generation: s.generation, BufferStart: s.raw.Start(), End: s.raw.End(), Log: s.log}
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

// deliverExit gives v the EXIT as its last frame. The session is over only
// once that frame is written: if v fails first, or stopped already, the
// next viewer gets the EXIT. The caller holds mu.
func (s *session) deliverExit(v *viewer) {
	s.viewer = nil
	v.stop(s.exitFrame(s.markDelivered), false)
}

func (s *session) markDelivered() {
	s.mu.Lock()
	s.delivered = true
	s.mu.Unlock()
	if s.onDelivered != nil {
		s.onDelivered()
	}
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
// and gives up once the viewer or the session ends. Input from a viewer that
// was taken over or dropped goes nowhere.
func (s *session) queueStdin(v *viewer, p []byte) {
	s.mu.Lock()
	current := s.viewer == v
	s.mu.Unlock()
	if !current {
		return
	}
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
		Generation:    s.generation,
		BootID:        s.bootID,
		End:           s.raw.End(),
		Log:           s.log,
	}
	if s.exit != nil {
		info.State = proto.SessionExited
	}
	return info
}

// ended returns the generation as previous: called once done closed, so
// its end and exit are final.
func (s *session) ended() proto.Previous {
	s.mu.Lock()
	defer s.mu.Unlock()
	return proto.Previous{Generation: s.generation, End: s.raw.End(), Exit: *s.exit}
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
