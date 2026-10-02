package inner

import (
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// ErrDown is the error for a spawn or signal when the container is gone.
var ErrDown = proc.ErrDown

// pendingCall waits for one reply. register runs in the read loop as the
// reply arrives, before the loop reads on: a spawn's waiter must exist
// before its exit can be read.
type pendingCall struct {
	ch       chan message
	register func(reply message)
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
// spawn and wait still open: a process in a dead container is dead.
func (c *client) run() {
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
				continue
			}
			if call.register != nil && m.Error == "" && m.Errno == 0 {
				call.register(m)
			}
			call.ch <- m
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

func statusOf(m message) reaper.Status {
	if m.Signal != 0 {
		return reaper.Status{Pid: m.Pid, Code: -1, Signal: syscall.Signal(m.Signal)}
	}
	return reaper.Status{Pid: m.Pid, Code: m.Code}
}

// shut fails every pending request and ends every wait with SIGKILL, which
// is what the container's end did to them.
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
		call.ch <- message{Op: opReply, Error: ErrDown.Error()}
	}
	for pid, ch := range waiters {
		ch <- reaper.Status{Pid: pid, Code: -1, Signal: syscall.SIGKILL}
	}
	unix.Close(c.sock)
	close(c.down)
}

// call sends m and waits for its reply. register, when set, runs in the
// read loop as a good reply arrives (pendingCall).
func (c *client) call(m message, fds []int, register func(reply message)) (message, error) {
	ch := make(chan message, 1)
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
	reply := <-ch
	if reply.Error == ErrDown.Error() {
		return reply, ErrDown
	}
	return reply, replyErr(reply)
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
	return proc.NewProcess(reply.Pid, done, c.signal), nil
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
	// pidfd kills it without a race with the pid's reuse
	pidfd int
	died  <-chan reaper.Status
	// sock is the agent's end of the socket
	sock int
	// reaped is set once connect took a status from died
	reaped bool
	// gone, once set by watchExit, closes when the init is reaped, with
	// status
	gone     chan struct{}
	status   reaper.Status
	killOnce sync.Once
}

// watchExit takes over died: from now on gone tells the init's end, to any
// number of waiters.
func (p *initProc) watchExit() {
	p.gone = make(chan struct{})
	safe.Go("inner: reap", func() {
		p.status = <-p.died
		close(p.gone)
	}, nil)
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
	return &initProc{pid: pid, pidfd: pidfd, died: done, sock: pair[0]}, nil
}

// kill ends the init, and with it every process in its PID namespace, and
// waits for it to be reaped. Call it once.
func (p *initProc) kill() {
	signal := func() {
		if err := unix.PidfdSendSignal(p.pidfd, unix.SIGKILL, nil, 0); err != nil && !errors.Is(err, unix.ESRCH) {
			log.Printf("inner: kill the init: %v", err)
		}
	}
	switch {
	case p.gone != nil:
		select {
		case <-p.gone:
		default:
			signal()
			<-p.gone
		}
	case !p.reaped:
		signal()
		<-p.died
		p.reaped = true
	}
	unix.Close(p.pidfd)
}

// connect starts a client on p's socket once the inner init is ready, and
// closes the socket when the init dies first.
func connect(p *initProc) (*client, error) {
	c := newClient(p.sock)
	ready := make(chan error, 1)
	safe.Go("inner: ready", func() { ready <- c.waitReady() }, func() { ready <- errors.New("panic") })
	select {
	case err := <-ready:
		if err != nil {
			unix.Close(p.sock)
			return nil, err
		}
	case st := <-p.died:
		p.reaped = true
		// the socket gets its EOF; the read must end before the fd number
		// can go to another socket
		<-ready
		unix.Close(p.sock)
		return nil, fmt.Errorf("the inner init exited before it was ready: %s", describe(st))
	}
	safe.Go("inner: socket", c.run, c.shut)
	return c, nil
}

func describe(st reaper.Status) string {
	if st.Signal != 0 {
		return "signal " + st.Signal.String()
	}
	return fmt.Sprintf("exit %d", st.Code)
}
