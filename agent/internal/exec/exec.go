// Package exec runs one exec request: it starts the process, streams its
// stdio over the connection, and reports its exit.
package exec

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/cgroup"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/pty"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// drainGrace bounds how long output is forwarded after the process exits.
// Background children that inherited stdout would otherwise hold the
// session open forever.
const drainGrace = 500 * time.Millisecond

// exitLinger bounds how long a session waits for the host to close after EXIT.
const exitLinger = 2 * time.Second

// hangupGrace bounds how long a session waits for its process after the host
// connection drops (for example a vsock reset on snapshot restore). A process
// that ignores SIGHUP keeps running, but no longer counts as a session.
const hangupGrace = time.Second

// stdin flow control. The host frames arrive on one ordered stream, read by
// one goroutine that also applies RESIZE and SIGNAL. Writes to the child's
// stdin happen on a separate writer goroutine, fed through a queue of
// stdinQueueChunks slots. A STDIN frame takes one slot per stdinChunk bytes
// or part of it, so the queue holds 1024 frames or 4 MiB, whichever comes
// first. A child that stops reading stdin fills the queue, not the reader,
// so RESIZE and SIGNAL frames that follow stay deliverable until the queue
// is full. Past that the reader blocks, which pushes back on the host;
// frames behind the pending stdin then wait too, because the stream is
// ordered.
const (
	stdinChunk       = 4 << 10
	stdinQueueChunks = 1024
)

// Manager runs exec sessions and counts the live ones.
type Manager struct {
	launcher *launch.Launcher
	// cgroups gives each non-tty exec a leaf; nil runs them without one,
	// and a stop then reaches only the process group.
	cgroups *cgroup.Tree
	// strict gives every exec, a tty one too, a leaf, and refuses the exec
	// that cannot have one
	strict bool
	active atomic.Int64

	leafFailed sync.Once
}

func NewManager(l *launch.Launcher, cgroups *cgroup.Tree) *Manager {
	return &Manager{launcher: l, cgroups: cgroups}
}

// NewStrictManager is NewManager for execs that must stay inside the limits
// of cgroups: each one, tty or not, starts in a leaf of it or not at all.
func NewStrictManager(l *launch.Launcher, cgroups *cgroup.Tree) *Manager {
	return &Manager{launcher: l, cgroups: cgroups, strict: true}
}

// Active returns the number of running exec sessions.
func (m *Manager) Active() int { return int(m.active.Load()) }

// Serve runs req to completion. r and w are the connection's frame streams;
// the caller closes the connection after Serve returns.
func (m *Manager) Serve(req proto.Request, r *proto.Reader, w *proto.Writer) error {
	m.active.Add(1)
	defer m.active.Add(-1)

	s, err := m.start(req)
	if err != nil {
		return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{
			Error: proto.StartError(err, errors.Is(err, proc.ErrDown)),
		})
	}
	if s.group != nil {
		defer m.cgroups.Release(s.group)
	}
	// A panic in the session ends it as a host hangup would: its pipes
	// close, which stops the pumps, and the process gets SIGHUP. In Serve
	// itself the panic then goes on to the request handler's recover.
	abort := func() {
		s.close()
		s.proc.Signal(syscall.SIGHUP)
	}
	defer func() {
		if v := recover(); v != nil {
			abort()
			panic(v)
		}
	}()
	if err := w.WriteJSON(proto.TypeStarted, proto.Started{Pid: s.proc.Pid, KillGraceMs: s.stop.grace.Milliseconds()}); err != nil {
		s.proc.Signal(syscall.SIGHUP)
	}

	var writer sync.WaitGroup
	writer.Add(1)
	safe.Go("exec stdin", func() {
		defer writer.Done()
		s.writeStdin()
	}, abort)
	var pumps sync.WaitGroup
	for _, o := range s.outputs {
		pumps.Add(1)
		safe.Go("exec output", func() {
			defer pumps.Done()
			pump(o.f, o.typ, w)
		}, abort)
	}
	hangup := make(chan struct{})
	safe.Go("exec input", func() {
		defer close(hangup)
		s.input(r)
	}, abort)

	var st reaper.Status
	select {
	case st = <-s.proc.Done:
	case <-hangup:
		select {
		case st = <-s.proc.Done:
		case <-time.After(hangupGrace):
			s.close()
			pumps.Wait()
			writer.Wait()
			return fmt.Errorf("pid %d: host hung up, process ignored SIGHUP; detaching", s.proc.Pid)
		}
	}
	s.exited.Store(true)
	// A command stopped by the host may leave group members that ignored
	// the signal (nohup). They go before the drain, so their last output
	// still reaches EOF and the host before EXIT.
	if deadline, ok := s.stop.due(); ok {
		if s.group != nil {
			killCgroup(s.group, s.proc, deadline)
		} else {
			killGroup(s.proc, deadline)
		}
	}
	for _, o := range s.outputs {
		o.f.SetReadDeadline(time.Now().Add(drainGrace))
	}
	pumps.Wait()
	s.close()
	writer.Wait()

	err = w.WriteJSON(proto.TypeExit, proto.ExitOf(st.Code, int(st.Signal)))
	// The host closes once it has EXIT. Read until then: a host frame that
	// races the exit (stdin EOF) must not hit a closed socket, or the host
	// loses the EXIT frame to EPIPE.
	select {
	case <-hangup:
	case <-time.After(exitLinger):
	}
	return err
}

type output struct {
	f   *os.File
	typ proto.Type
}

type session struct {
	proc *proc.Process
	// group is the exec's cgroup leaf; nil when the exec runs without one,
	// as a tty exec does unless its manager is strict
	group   *cgroup.Group
	tty     *os.File // pty master, nil without a tty
	stdin   *os.File // write end of the stdin pipe, nil with a tty
	outputs []output
	exited  atomic.Bool
	stop    stopTimer
	mu      sync.Mutex // guards stdin close

	// stdinQ carries STDIN payloads from input to writeStdin. Only input
	// sends on or closes it; stdinEnded records the close.
	stdinQ     chan []byte
	stdinEnded bool
	// done closes when the session ends, so input and writeStdin stop
	// waiting on each other.
	done      chan struct{}
	closeOnce sync.Once
}

func (m *Manager) start(req proto.Request) (*session, error) {
	s := &session{
		stdinQ: make(chan []byte, stdinQueueChunks),
		done:   make(chan struct{}),
		stop:   stopTimer{grace: killGrace(req)},
	}
	if req.TTY {
		group, err := m.ttyGroup()
		if err != nil {
			return nil, err
		}
		var dir *os.File
		if group != nil {
			dir = group.Dir()
		}
		p, master, err := m.launcher.StartPTY(req, dir)
		if err != nil {
			if group != nil {
				m.cgroups.Release(group)
			}
			return nil, err
		}
		s.proc, s.tty, s.group = p, master, group
		s.outputs = []output{{master, proto.TypeStdout}}
		return s, nil
	}

	spec, err := m.launcher.Spec(req)
	if err != nil {
		return nil, err
	}
	var pipes [3][2]*os.File
	for i := range pipes {
		r, w, err := os.Pipe()
		if err != nil {
			closeAll(pipes[:i])
			return nil, err
		}
		pipes[i] = [2]*os.File{r, w}
	}
	s.stdin = pipes[0][1]
	s.outputs = []output{{pipes[1][0], proto.TypeStdout}, {pipes[2][0], proto.TypeStderr}}
	spec.Files = []*os.File{pipes[0][0], pipes[1][1], pipes[2][1]}
	group, err := m.newGroup()
	if err != nil {
		closeAll(pipes[:])
		return nil, err
	}
	if group != nil {
		spec.Cgroup = group.Dir()
	}

	p, err := m.launcher.Start(spec)
	for _, f := range spec.Files {
		f.Close()
	}
	if err != nil {
		if group != nil {
			m.cgroups.Release(group)
		}
		s.close()
		return nil, err
	}
	if group != nil && !p.InCgroup {
		m.cgroups.Release(group)
		group = nil
	}
	s.proc, s.group = p, group
	return s, nil
}

// newGroup makes a leaf for a new exec, or returns nil when there is no tree
// or the leaf cannot be made (logged once). A strict manager returns the
// error instead.
func (m *Manager) newGroup() (*cgroup.Group, error) {
	if m.cgroups == nil {
		if m.strict {
			return nil, errors.New("no cgroup to run in")
		}
		return nil, nil
	}
	g, err := m.cgroups.New()
	if err != nil {
		if m.strict {
			return nil, fmt.Errorf("cgroup: %w", err)
		}
		m.leafFailed.Do(func() {
			log.Printf("exec: no cgroup for execs (%v); a stop reaches only the process group", err)
		})
		return nil, nil
	}
	return g, nil
}

// ttyGroup is newGroup for a tty exec, which only a strict manager gives a
// leaf: its process group belongs to the terminal, so no stop sweeps it.
func (m *Manager) ttyGroup() (*cgroup.Group, error) {
	if !m.strict {
		return nil, nil
	}
	return m.newGroup()
}

// input applies host frames until the connection ends. If the host goes away
// while the process runs, the process group gets SIGHUP, as a terminal
// hangup would deliver.
func (s *session) input(r *proto.Reader) {
	for {
		f, err := r.Next()
		if err != nil {
			if !s.exited.Load() {
				s.proc.Signal(syscall.SIGHUP)
			}
			s.endStdin()
			return
		}
		switch f.Type {
		case proto.TypeStdin:
			if !s.queueStdin(f.Payload) {
				return
			}
		case proto.TypeStdinEOF:
			// A tty has no EOF to give; the client sends ^D itself.
			if s.tty == nil {
				s.endStdin()
			}
		case proto.TypeResize:
			var rs proto.Resize
			if s.tty != nil && json.Unmarshal(f.Payload, &rs) == nil {
				pty.SetWinsize(s.tty, rs.Cols, rs.Rows)
			}
		case proto.TypeSignal:
			var sig proto.Signal
			if json.Unmarshal(f.Payload, &sig) == nil && sig.Signal > 0 && !s.exited.Load() {
				s.stop.arm(syscall.Signal(sig.Signal))
				s.proc.Signal(syscall.Signal(sig.Signal))
			}
		default:
			log.Printf("exec: ignoring %s frame", f.Type)
		}
	}
}

// queueStdin hands p to writeStdin in chunks. It blocks while the queue is
// full and returns false if the session ended meanwhile.
func (s *session) queueStdin(p []byte) bool {
	if s.stdinEnded {
		return true
	}
	for len(p) > 0 {
		n := min(len(p), stdinChunk)
		select {
		case s.stdinQ <- p[:n]:
		case <-s.done:
			return false
		}
		p = p[n:]
	}
	return true
}

// endStdin closes the queue; writeStdin closes the pipe once it drains.
func (s *session) endStdin() {
	if !s.stdinEnded {
		s.stdinEnded = true
		close(s.stdinQ)
	}
}

// writeStdin writes queued stdin to the process. After a failed write (the
// process closed its stdin) it discards the rest, so the queue never stalls
// the reader. close unblocks a write the process never reads.
func (s *session) writeStdin() {
	w := s.stdinWriter()
	for {
		select {
		case p, ok := <-s.stdinQ:
			if !ok {
				s.closeStdin()
				return
			}
			if w != nil {
				if _, err := w.Write(p); err != nil {
					w = nil
				}
			}
		case <-s.done:
			return
		}
	}
}

func (s *session) stdinWriter() io.Writer {
	if s.tty != nil {
		return s.tty
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stdin == nil {
		return nil
	}
	return s.stdin
}

func (s *session) closeStdin() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stdin != nil {
		s.stdin.Close()
		s.stdin = nil
	}
}

func (s *session) close() {
	s.closeOnce.Do(func() { close(s.done) })
	s.closeStdin()
	for _, o := range s.outputs {
		o.f.Close()
	}
}

// pump forwards f to the host as typ frames until EOF, EIO (a pty whose
// slave side is fully closed), or the drain deadline.
func pump(f *os.File, typ proto.Type, w *proto.Writer) {
	buf := make([]byte, 32<<10)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if w.Write(typ, buf[:n]) != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func closeAll(pipes [][2]*os.File) {
	for _, p := range pipes {
		p[0].Close()
		p[1].Close()
	}
}
