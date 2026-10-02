package inner

import (
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// ErrDown is the error for a spawn or signal when the container is gone.
var ErrDown = proc.ErrDown

// callTimeout bounds a request to the inner init: one that hangs (a stat on
// a dead FUSE mount, say) fails instead of holding its caller. A variable
// for tests.
var callTimeout = 30 * time.Second

// errNoAnswer is a request the inner init did not answer within callTimeout.
var errNoAnswer = errors.New("the inner init did not answer")

// pendingCall waits for one reply. register runs in the read loop as the
// reply arrives, before the loop reads on: a spawn's waiter must exist
// before its exit can be read.
type pendingCall struct {
	ch       chan result
	register func(reply message)
}

type result struct {
	m   message
	err error
}

// client is the agent's half of one container's socket. It implements
// proc.Runner: each Start is a spawn in the container.
type client struct {
	sock int

	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  uint64
	pending map[uint64]*pendingCall
	waiters map[int]chan reaper.Status
	closed  bool
	// down closes when the socket does
	down chan struct{}
}

func newClient(sock int) *client {
	return &client{
		sock:    sock,
		pending: make(map[uint64]*pendingCall),
		waiters: make(map[int]chan reaper.Status),
		down:    make(chan struct{}),
	}
}

// waitReady reads the inner init's first message, sent once its namespaces
// are set up.
func (c *client) waitReady() error {
	m, fds, err := recv(c.sock, make([]byte, 4096))
	closeAll(fds)
	if err != nil {
		return err
	}
	if m.Op != opReady {
		return fmt.Errorf("the inner init said %q before it was ready", m.Op)
	}
	return nil
}

// run reads replies and exits until the socket closes, then ends every
// spawn and wait still open: a process in a dead container is dead. It owns
// the socket's fd and closes it last.
func (c *client) run() {
	defer unix.Close(c.sock)
	defer c.shut()
	buf := newBuffer()
	for {
		m, fds, err := recv(c.sock, buf)
		closeAll(fds)
		if err != nil {
			if !errors.Is(err, errClosed) {
				log.Printf("inner: read: %v", err)
			}
			return
		}
		switch m.Op {
		case opReply:
			c.mu.Lock()
			call := c.pending[m.ID]
			delete(c.pending, m.ID)
			c.mu.Unlock()
			if call == nil {
				c.late(m)
				continue
			}
			if call.register != nil && m.Error == "" && m.Errno == 0 {
				call.register(m)
			}
			call.ch <- result{m: m}
		case opExit:
			c.mu.Lock()
			ch := c.waiters[m.Pid]
			delete(c.waiters, m.Pid)
			c.mu.Unlock()
			if ch != nil {
				ch <- statusOf(m)
			}
		}
	}
}

// late handles a reply that came after its call gave up. A spawn that
// started then has nobody to wait for it, so it goes.
func (c *client) late(m message) {
	if m.Pid <= 0 || m.Error != "" || m.Errno != 0 {
		return
	}
	log.Printf("inner: pid %d started after its spawn timed out; killing it", m.Pid)
	safe.Go("inner: kill late spawn", func() { c.signal(m.Pid, syscall.SIGKILL, false) }, nil)
}

func statusOf(m message) reaper.Status {
	if m.Signal != 0 {
		return reaper.Status{Pid: m.Pid, Code: -1, Signal: syscall.Signal(m.Signal)}
	}
	return reaper.Status{Pid: m.Pid, Code: m.Code}
}

// shut fails every pending request and ends every wait with SIGKILL, which
// is what the container's end did to them. It shuts the socket down; run
// closes the fd.
func (c *client) shut() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	pending, waiters := c.pending, c.waiters
	c.pending, c.waiters = map[uint64]*pendingCall{}, map[int]chan reaper.Status{}
	c.mu.Unlock()
	for _, call := range pending {
		call.ch <- result{err: ErrDown}
	}
	for pid, ch := range waiters {
		ch <- reaper.Status{Pid: pid, Code: -1, Signal: syscall.SIGKILL}
	}
	unix.Shutdown(c.sock, unix.SHUT_RDWR)
	close(c.down)
}

// call sends m and waits for its reply, at most callTimeout. register, when
// set, runs in the read loop as a good reply arrives (pendingCall).
func (c *client) call(m message, fds []int, register func(reply message)) (message, error) {
	ch := make(chan result, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return message{}, ErrDown
	}
	c.nextID++
	m.ID = c.nextID
	c.pending[m.ID] = &pendingCall{ch: ch, register: register}
	c.mu.Unlock()

	c.writeMu.Lock()
	err := send(c.sock, m, fds)
	c.writeMu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, m.ID)
		c.mu.Unlock()
		return message{}, fmt.Errorf("%w: %v", ErrDown, err)
	}
	t := time.NewTimer(callTimeout)
	defer t.Stop()
	select {
	case r := <-ch:
		if r.err != nil {
			return r.m, r.err
		}
		return r.m, replyErr(r.m)
	case <-t.C:
	}
	c.mu.Lock()
	_, waiting := c.pending[m.ID]
	delete(c.pending, m.ID)
	c.mu.Unlock()
	if !waiting {
		// the reply won the race after all
		r := <-ch
		if r.err != nil {
			return r.m, r.err
		}
		return r.m, replyErr(r.m)
	}
	return message{}, fmt.Errorf("%s: %w after %s", m.Op, errNoAnswer, callTimeout)
}

// Start spawns s in the container. Its pid is the container's pid for it.
func (c *client) Start(s proc.Spec) (*proc.Process, error) {
	fds := make([]int, 0, len(s.Files)+1)
	for _, f := range s.Files {
		fds = append(fds, int(f.Fd()))
	}
	if s.Cgroup != nil {
		fds = append(fds, int(s.Cgroup.Fd()))
	}
	done := make(chan reaper.Status, 1)
	// The exit can only follow the reply on the socket; the read loop
	// registers the waiter before it reads on.
	reply, err := c.call(message{Op: opSpawn, Spec: toWire(s)}, fds, func(reply message) {
		c.mu.Lock()
		if c.closed {
			done <- reaper.Status{Pid: reply.Pid, Code: -1, Signal: syscall.SIGKILL}
		} else {
			c.waiters[reply.Pid] = done
		}
		c.mu.Unlock()
	})
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", s.Argv[0], err)
	}
	p := proc.NewProcess(reply.Pid, done, c.signal)
	p.InCgroup = reply.InCgroup
	return p, nil
}

func (c *client) signal(pid int, sig syscall.Signal, group bool) error {
	_, err := c.call(message{Op: opSignal, Pid: pid, Sig: int(sig), Group: group}, nil, nil)
	if errors.Is(err, ErrDown) {
		// nothing is left in a dead container
		return syscall.ESRCH
	}
	return err
}

// Down closes when the container's socket does.
func (c *client) Down() <-chan struct{} { return c.down }

// initProc is a started inner init.
type initProc struct {
	pid int
	// sock is the agent's end of the socket
	sock int
	// signalKill sends the init SIGKILL; release frees what that needs,
	// once the init is reaped
	signalKill func() error
	release    func()
	// gone closes once the init is reaped, with status
	gone     chan struct{}
	status   reaper.Status
	killOnce sync.Once
}

func newInitProc(pid, sock int, died <-chan reaper.Status, signalKill func() error, release func()) *initProc {
	p := &initProc{pid: pid, sock: sock, signalKill: signalKill, release: release, gone: make(chan struct{})}
	safe.Go("inner: reap", func() {
		p.status = <-died
		close(p.gone)
	}, nil)
	return p
}

// kill ends the init, and with it every process in its PID namespace, and
// waits for it to be reaped. Only the first call does anything.
func (p *initProc) kill() {
	p.killOnce.Do(func() {
		select {
		case <-p.gone:
		default:
			if err := p.signalKill(); err != nil && !errors.Is(err, unix.ESRCH) {
				log.Printf("inner: kill the init: %v", err)
			}
			<-p.gone
		}
		p.release()
	})
}

// startInit forks the inner init from agent, with flags, env and in cgroup.
func startInit(r *reaper.Reaper, agent string, cloneflags uintptr, cgroup *os.File, env []string) (*initProc, error) {
	pair, err := newSocketpair()
	if err != nil {
		return nil, fmt.Errorf("socketpair: %w", err)
	}
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		unix.Close(pair[0])
		unix.Close(pair[1])
		return nil, err
	}
	defer devnull.Close()
	pidfd := -1
	sys := &syscall.SysProcAttr{Cloneflags: cloneflags, PidFD: &pidfd}
	if cgroup != nil {
		sys.UseCgroupFD = true
		sys.CgroupFD = int(cgroup.Fd())
	}
	attr := &syscall.ProcAttr{
		Dir: "/",
		Env: env,
		// its log goes where the agent's does: the console
		Files: []uintptr{devnull.Fd(), os.Stderr.Fd(), os.Stderr.Fd(), uintptr(pair[1])},
		Sys:   sys,
	}
	pid, done, err := r.Start(func() (int, error) {
		return syscall.ForkExec(agent, []string{agent, Command}, attr)
	})
	unix.Close(pair[1])
	if err != nil {
		unix.Close(pair[0])
		return nil, fmt.Errorf("start the inner init: %w", err)
	}
	return newInitProc(pid, pair[0], done,
		func() error { return unix.PidfdSendSignal(pidfd, unix.SIGKILL, nil, 0) },
		func() { unix.Close(pidfd) }), nil
}

// readyTimeout bounds the inner init's setup. A variable for tests.
var readyTimeout = 30 * time.Second

// connect starts a client on p's socket once the inner init is ready. When
// the init dies first, or takes longer than readyTimeout, it kills the init
// and closes the socket.
func connect(p *initProc) (*client, error) {
	c := newClient(p.sock)
	ready := make(chan error, 1)
	safe.Go("inner: ready", func() { ready <- c.waitReady() }, func() { ready <- errors.New("panic") })
	var err error
	read := false
	select {
	case err = <-ready:
		if err == nil {
			safe.Go("inner: socket", c.run, c.shut)
			return c, nil
		}
		read = true
	case <-p.gone:
		err = fmt.Errorf("the inner init exited before it was ready: %s", describe(p.status))
	case <-time.After(readyTimeout):
		err = fmt.Errorf("the inner init was not ready after %s", readyTimeout)
	}
	p.kill()
	if !read {
		// the read must end before the fd number can go to another socket
		unix.Shutdown(p.sock, unix.SHUT_RDWR)
		<-ready
	}
	unix.Close(p.sock)
	return nil, err
}

func describe(st reaper.Status) string {
	if st.Signal != 0 {
		return "signal " + st.Signal.String()
	}
	return fmt.Sprintf("exit %d", st.Code)
}
