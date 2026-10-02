package inner

import (
	"errors"
	"log"
	"os"
	"sync"
	"syscall"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// spawner is the inner init's half of the socket: it starts what the agent
// asks for and reports each exit. Every spec resolves here, in the user's
// world: its user against the inner /etc/passwd, its binary on the inner
// PATH.
type spawner struct {
	sock   int
	runner proc.Runner

	writeMu sync.Mutex

	mu    sync.Mutex
	procs map[int]*proc.Process
}

// serve answers the agent until the socket closes.
func serve(sock int, runner proc.Runner) error {
	s := &spawner{sock: sock, runner: runner, procs: make(map[int]*proc.Process)}
	if err := s.write(message{Op: opReady}, nil); err != nil {
		return err
	}
	buf := newBuffer()
	for {
		m, fds, err := recv(sock, buf)
		if err != nil {
			return err
		}
		switch m.Op {
		case opSpawn:
			// each on its own: a spawn that hangs (a stat on a dead FUSE
			// mount) must not hold the others, or a signal
			safe.Go("inner: spawn", func() { s.spawn(m, fds) }, nil)
		case opSignal:
			closeAll(fds)
			s.signal(m)
		default:
			closeAll(fds)
			s.reply(m.ID, 0, nil, errors.New("unknown op "+m.Op))
		}
	}
}

func (s *spawner) write(m message, fds []int) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return send(s.sock, m, fds)
}

func (s *spawner) reply(id uint64, pid int, fds []int, err error) {
	s.send(message{ID: id, Op: opReply, Pid: pid}, fds, err)
}

func (s *spawner) send(m message, fds []int, err error) {
	if err != nil {
		m.Error, m.Errno = err.Error(), errnoOf(err)
	}
	if werr := s.write(m, fds); werr != nil {
		log.Printf("inner: reply %d: %v", m.ID, werr)
	}
}

func (s *spawner) spawn(m message, fds []int) {
	files := make([]*os.File, len(fds))
	for i, fd := range fds {
		files[i] = os.NewFile(uintptr(fd), "spawn")
	}
	// the child holds its own copies; these go once it started
	defer func() {
		for _, f := range files {
			f.Close()
		}
	}()
	w := m.Spec
	want := 0
	if w != nil {
		want = w.Files
		if w.HasCgroup {
			want++
		}
	}
	if w == nil || len(files) != want {
		s.reply(m.ID, 0, nil, errors.New("a spawn needs its spec and every fd it names"))
		return
	}
	spec := proc.Spec{
		Argv: w.Argv, Env: w.Env, Dir: w.Dir, Workdir: w.Workdir, User: w.User,
		SetHome: w.SetHome, TTY: w.TTY, Helper: w.Helper, Files: files[:w.Files],
	}
	if w.Cred != nil {
		spec.Cred = &syscall.Credential{Uid: w.Cred.Uid, Gid: w.Cred.Gid, Groups: w.Cred.Groups}
	}
	if w.HasCgroup {
		spec.Cgroup = files[w.Files]
	}
	p, err := s.runner.Start(spec)
	if err != nil {
		s.reply(m.ID, 0, nil, err)
		return
	}
	s.mu.Lock()
	s.procs[p.Pid] = p
	s.mu.Unlock()
	// the reply goes before the exit can: the exit waits for it
	s.send(message{ID: m.ID, Op: opReply, Pid: p.Pid, InCgroup: p.InCgroup}, nil, nil)
	safe.Go("inner: wait", func() {
		st := <-p.Done
		s.mu.Lock()
		delete(s.procs, p.Pid)
		s.mu.Unlock()
		exit := message{Op: opExit, Pid: p.Pid, Code: st.Code, Signal: int(st.Signal)}
		if err := s.write(exit, nil); err != nil {
			log.Printf("inner: exit of %d: %v", p.Pid, err)
		}
	}, nil)
}

// signal sends a signal to a process group, which outlives its leader, or
// to one child it started, which must not reach a later process with the
// same pid.
func (s *spawner) signal(m message) {
	sig := syscall.Signal(m.Sig)
	if m.Group {
		s.reply(m.ID, 0, nil, syscall.Kill(-m.Pid, sig))
		return
	}
	s.mu.Lock()
	p := s.procs[m.Pid]
	s.mu.Unlock()
	if p == nil {
		s.reply(m.ID, 0, nil, syscall.ESRCH)
		return
	}
	if sig == syscall.SIGKILL {
		s.reply(m.ID, 0, nil, p.Kill())
		return
	}
	s.reply(m.ID, 0, nil, syscall.Kill(m.Pid, sig))
}
