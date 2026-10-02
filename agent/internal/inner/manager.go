package inner

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// CgroupDir is the container's cgroup, as the agent sees it: the root of
// the container's cgroup namespace. ExecCgroupDir under it holds a leaf per
// exec; it stays when the container starts again.
const (
	CgroupDir     = "/sys/fs/cgroup/user"
	ExecCgroupDir = CgroupDir + "/exec"
)

// Restarts after the container dies: 1 s doubling to 30 s, and at most
// maxRestarts in restartWindow. After `rm -rf /` every start fails, and the
// container stays down until the next boot.
const (
	minBackoff    = time.Second
	maxBackoff    = 30 * time.Second
	maxRestarts   = 5
	restartWindow = 10 * time.Minute
	killWait      = 5 * time.Second
)

// Manager runs the inner container and starts it again when it dies. It is
// the agent's proc.Runner for user processes.
type Manager struct {
	reaper *reaper.Reaper
	cfg    Config

	mu      sync.Mutex
	current *client
	// rootMu keeps the root open while an operation uses it
	rootMu   sync.RWMutex
	root     *fsroot.Root
	initPid  int
	restarts int
	starts   []time.Time
	lastErr  string
	stopped  bool
	onDown   []func()
	onUp     []func()
}

// Start sets up the container's cgroup and starts the container. A first
// start that fails leaves the agent up, the container down, and the
// restarts going.
func Start(r *reaper.Reaper, cfg Config) *Manager {
	m := &Manager{reaper: r, cfg: cfg}
	if err := m.startOnce(); err != nil {
		log.Printf("inner: %v", err)
		m.mu.Lock()
		m.lastErr = err.Error()
		m.mu.Unlock()
		safe.Go("inner: restart", m.restartLoop, nil)
	}
	return m
}

// OnDown runs fn each time the container dies, before it starts again: for
// what held its files open, such as the agent's sockets in its /run.
func (m *Manager) OnDown(fn func()) {
	m.mu.Lock()
	m.onDown = append(m.onDown, fn)
	m.mu.Unlock()
}

// OnUp runs fn each time a container starts after the first: for its
// services.
func (m *Manager) OnUp(fn func()) {
	m.mu.Lock()
	m.onUp = append(m.onUp, fn)
	m.mu.Unlock()
}

// startOnce starts one container and watches it.
func (m *Manager) startOnce() error {
	m.mu.Lock()
	m.starts = append(m.starts, time.Now())
	m.mu.Unlock()
	cg, err := os.Open(CgroupDir)
	if err != nil {
		return fmt.Errorf("open %s: %w", CgroupDir, err)
	}
	defer cg.Close()
	pid, died, sock, err := startInit(m.reaper, AgentBinary,
		syscall.CLONE_NEWNS|syscall.CLONE_NEWPID|syscall.CLONE_NEWCGROUP, cg, m.cfg.env())
	if err != nil {
		return err
	}
	c, err := connect(sock, died)
	if err != nil {
		killCgroup()
		return err
	}
	root, err := fsroot.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		c.shut()
		killCgroup()
		return fmt.Errorf("open the container's root: %w", err)
	}
	m.rootMu.Lock()
	m.root = root
	m.rootMu.Unlock()
	m.mu.Lock()
	m.current, m.initPid, m.lastErr = c, pid, ""
	m.mu.Unlock()
	log.Printf("inner: up, init pid %d", pid)
	safe.Go("inner: watch", func() { m.watch(c, died) }, nil)
	return nil
}

// watch waits for the container to end: its init dying or its socket
// closing. Either way every process in it goes.
func (m *Manager) watch(c *client, died <-chan reaper.Status) {
	select {
	case st := <-died:
		log.Printf("inner: the init died (%s)", describe(st))
		c.shut()
	case <-c.Down():
		log.Printf("inner: the socket closed")
	}
	killCgroup()
	m.mu.Lock()
	mine := m.current == c
	if mine {
		m.current = nil
	}
	m.mu.Unlock()
	if mine {
		m.rootMu.Lock()
		if m.root != nil {
			m.root.Close()
			m.root = nil
		}
		m.rootMu.Unlock()
	}
	m.mu.Lock()
	stopped := m.stopped
	downs := append([]func(){}, m.onDown...)
	m.mu.Unlock()
	for _, fn := range downs {
		safe.Call("inner: on down", fn)
	}
	if !stopped {
		m.restartLoop()
	}
}

// restartLoop starts the container again with backoff, until it is up, the
// manager stops, or the restarts in the window run out.
func (m *Manager) restartLoop() {
	backoff := minBackoff
	for {
		m.mu.Lock()
		if m.stopped {
			m.mu.Unlock()
			return
		}
		recent := 0
		for _, t := range m.starts {
			if time.Since(t) < restartWindow {
				recent++
			}
		}
		if recent > maxRestarts {
			m.lastErr = fmt.Sprintf("gave up after %d starts in %s: %s", recent, restartWindow, m.lastErr)
			log.Printf("inner: %s", m.lastErr)
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()

		time.Sleep(backoff)
		backoff = min(backoff*2, maxBackoff)

		m.mu.Lock()
		if m.stopped {
			m.mu.Unlock()
			return
		}
		m.restarts++
		m.mu.Unlock()
		if err := m.startOnce(); err != nil {
			log.Printf("inner: restart: %v", err)
			m.mu.Lock()
			m.lastErr = err.Error()
			m.mu.Unlock()
			continue
		}
		m.mu.Lock()
		ups := append([]func(){}, m.onUp...)
		m.mu.Unlock()
		for _, fn := range ups {
			safe.Call("inner: on up", fn)
		}
		return
	}
}

// Start is the Runner: it spawns s in the current container.
func (m *Manager) Start(s proc.Spec) (*proc.Process, error) {
	m.mu.Lock()
	c := m.current
	m.mu.Unlock()
	if c == nil {
		return nil, ErrDown
	}
	return c.Start(s)
}

// Status is the container's state for ping and activity.
type Status struct {
	Up       bool
	Restarts int
	LastErr  string
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return Status{Up: m.current != nil, Restarts: m.restarts, LastErr: m.lastErr}
}

// InitPid is the inner init's pid in the agent's namespace, or 0 while the
// container is down.
func (m *Manager) InitPid() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return 0
	}
	return m.initPid
}

// Stop ends the container for good: for a poweroff.
func (m *Manager) Stop() {
	m.mu.Lock()
	m.stopped = true
	m.mu.Unlock()
	killCgroup()
}

// Root is the current container's root, for the user's files. It answers
// ErrDown while no container runs.
func (m *Manager) Root() fsroot.FS { return liveRoot{m} }

// withRoot runs fn on the current root, which stays open until fn returns.
func (m *Manager) withRoot(fn func(r *fsroot.Root) error) error {
	m.rootMu.RLock()
	defer m.rootMu.RUnlock()
	if m.root == nil {
		return ErrDown
	}
	return fn(m.root)
}

func (c Config) env() []string {
	if c.RunSize == "" {
		return []string{}
	}
	return []string{runSizeEnv + "=" + c.RunSize}
}

// killCgroup ends every process in the container's cgroup and waits for
// them to go, then removes the cgroups the container made, so the next one
// starts clean.
func killCgroup() {
	if err := os.WriteFile(CgroupDir+"/cgroup.kill", []byte("1"), 0); err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("inner: cgroup.kill: %v", err)
	}
	deadline := time.Now().Add(killWait)
	for populated() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if populated() {
		log.Printf("inner: processes outlived cgroup.kill by %s", killWait)
		return
	}
	removeChildren(CgroupDir)
	if err := os.Mkdir(ExecCgroupDir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		log.Printf("inner: %v", err)
	}
}

func populated() bool {
	b, err := os.ReadFile(CgroupDir + "/cgroup.events")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if line == "populated 1" {
			return true
		}
	}
	return false
}

// removeChildren removes every cgroup under dir, deepest first.
func removeChildren(dir string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		child := filepath.Join(dir, e.Name())
		removeChildren(child)
		if err := os.Remove(child); err != nil {
			log.Printf("inner: remove %s: %v", child, err)
		}
	}
}

// liveRoot is the FS of whichever container runs.
type liveRoot struct{ m *Manager }

func (l liveRoot) with(fn func(r *fsroot.Root) error) error { return l.m.withRoot(fn) }

func (l liveRoot) OpenFile(p string, flag int, perm os.FileMode) (f *os.File, err error) {
	err = l.with(func(r *fsroot.Root) error { f, err = r.OpenFile(p, flag, perm); return err })
	return f, err
}

func (l liveRoot) ReadFile(p string) (b []byte, err error) {
	err = l.with(func(r *fsroot.Root) error { b, err = r.ReadFile(p); return err })
	return b, err
}

func (l liveRoot) ReadDir(p string) (ents []fs.DirEntry, err error) {
	err = l.with(func(r *fsroot.Root) error { ents, err = r.ReadDir(p); return err })
	return ents, err
}

func (l liveRoot) Stat(p string) (fi fs.FileInfo, err error) {
	err = l.with(func(r *fsroot.Root) error { fi, err = r.Stat(p); return err })
	return fi, err
}

func (l liveRoot) Lstat(p string) (fi fs.FileInfo, err error) {
	err = l.with(func(r *fsroot.Root) error { fi, err = r.Lstat(p); return err })
	return fi, err
}

func (l liveRoot) MkdirAll(p string, perm os.FileMode) error {
	return l.with(func(r *fsroot.Root) error { return r.MkdirAll(p, perm) })
}

func (l liveRoot) Rename(o, n string) error {
	return l.with(func(r *fsroot.Root) error { return r.Rename(o, n) })
}

func (l liveRoot) Remove(p string) error {
	return l.with(func(r *fsroot.Root) error { return r.Remove(p) })
}

func (l liveRoot) RemoveAll(p string) error {
	return l.with(func(r *fsroot.Root) error { return r.RemoveAll(p) })
}

func (l liveRoot) Truncate(p string, size int64) error {
	return l.with(func(r *fsroot.Root) error { return r.Truncate(p, size) })
}

func (l liveRoot) Lchown(p string, uid, gid int) error {
	return l.with(func(r *fsroot.Root) error { return r.Lchown(p, uid, gid) })
}

func (l liveRoot) Chmod(p string, mode os.FileMode) error {
	return l.with(func(r *fsroot.Root) error { return r.Chmod(p, mode) })
}

func (l liveRoot) Dir(p string) (f *os.File, err error) {
	err = l.with(func(r *fsroot.Root) error { f, err = r.Dir(p); return err })
	return f, err
}
