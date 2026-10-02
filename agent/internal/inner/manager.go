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

// Restarts after the container dies: 1 s doubling to 30 s. A start that
// fails, or a container that dies within stableAfter of its start, is a bad
// start; after more than maxBadStarts in restartWindow the agent gives up
// until the next boot. A root wiped by `rm -rf /` still starts: the init
// needs nothing from it.
const (
	minBackoff    = time.Second
	maxBackoff    = 30 * time.Second
	maxBadStarts  = 5
	restartWindow = 10 * time.Minute
	stableAfter   = time.Minute
	killWait      = 5 * time.Second
)

// Manager runs the inner container and starts it again when it dies. It is
// the agent's proc.Runner for user processes.
type Manager struct {
	cfg       Config
	cgroupDir string
	// startInit starts one inner init, and rootOf names its root: a fork
	// and /proc/<pid>/root, or a spawner in the test's own process
	startInit func(cgroup *os.File) (*initProc, error)
	rootOf    func(pid int) string

	mu      sync.Mutex
	current *client
	init    *initProc
	// rootMu keeps the root open while an operation uses it
	rootMu   sync.RWMutex
	root     *fsroot.Root
	restarts int
	bad      badStarts
	lastErr  string
	stopped  bool
	onDown   []func()
	onUp     []func()
	// watching counts the watch goroutines, which Stop waits for; stopCh
	// ends a restart's backoff
	watching sync.WaitGroup
	stopCh   chan struct{}
}

// New makes the container's manager; Launch starts it.
func New(r *reaper.Reaper, cfg Config) *Manager {
	return &Manager{
		stopCh:    make(chan struct{}),
		cfg:       cfg,
		cgroupDir: CgroupDir,
		startInit: func(cgroup *os.File) (*initProc, error) {
			return startInit(r, AgentBinary,
				syscall.CLONE_NEWNS|syscall.CLONE_NEWPID|syscall.CLONE_NEWCGROUP, cgroup, cfg.env())
		},
		rootOf: func(pid int) string { return fmt.Sprintf("/proc/%d/root", pid) },
	}
}

// Launch starts the container. A first start that fails leaves the agent
// up, the container down, and the restarts going. The hooks must be set
// before.
func (m *Manager) Launch() {
	if err := m.startOnce(); err != nil {
		log.Printf("inner: %v", err)
		safe.Go("inner: restart", m.restartLoop, nil)
	}
}

// OnDown runs fn each time the container dies, before it starts again: for
// what held its files open, such as the agent's sockets in its /run.
func (m *Manager) OnDown(fn func()) {
	m.mu.Lock()
	m.onDown = append(m.onDown, fn)
	m.mu.Unlock()
}

// OnUp runs fn each time a container starts after the first: for its
// files and services.
func (m *Manager) OnUp(fn func()) {
	m.mu.Lock()
	m.onUp = append(m.onUp, fn)
	m.mu.Unlock()
}

// startOnce starts one container and watches it. A failed start counts as
// a bad one.
func (m *Manager) startOnce() error {
	err := m.tryStart()
	if err != nil {
		m.mu.Lock()
		m.bad.add(time.Now())
		m.lastErr = err.Error()
		m.mu.Unlock()
	}
	return err
}

func (m *Manager) tryStart() error {
	// what a container left behind (a cgroup that outlived the last wait,
	// say) must not fail this one
	m.cleanCgroup()
	cg, err := os.Open(m.cgroupDir)
	if err != nil {
		return fmt.Errorf("open %s: %w", m.cgroupDir, err)
	}
	defer cg.Close()
	p, err := m.startInit(cg)
	if err != nil {
		return err
	}
	c, err := connect(p)
	if err != nil {
		m.cleanCgroup()
		return err
	}
	root, err := fsroot.Open(m.rootOf(p.pid))
	if err != nil {
		c.shut()
		p.kill()
		m.cleanCgroup()
		return fmt.Errorf("open the container's root: %w", err)
	}
	m.rootMu.Lock()
	m.root = root
	m.rootMu.Unlock()
	m.mu.Lock()
	m.current, m.init, m.lastErr = c, p, ""
	stopped := m.stopped
	m.mu.Unlock()
	log.Printf("inner: up, init pid %d", p.pid)
	started := time.Now()
	m.watching.Add(1)
	safe.Go("inner: watch", func() {
		defer m.watching.Done()
		m.watch(c, p, started)
	}, nil)
	if stopped {
		// a Stop ran during the start and missed this init
		p.kill()
	}
	return nil
}

// watch waits for the container to end: its init dying, or its socket
// closing, after which the init is killed. Either way every process in it
// goes with its PID namespace.
func (m *Manager) watch(c *client, p *initProc, started time.Time) {
	select {
	case <-p.gone:
		log.Printf("inner: the init died (%s)", describe(p.status))
		c.shut()
	case <-c.Down():
		log.Printf("inner: the socket closed")
	}
	p.kill()
	m.cleanCgroup()
	m.mu.Lock()
	if m.current == c {
		m.current, m.init = nil, nil
	}
	if time.Since(started) < stableAfter {
		m.bad.add(time.Now())
	}
	stopped := m.stopped
	downs := append([]func(){}, m.onDown...)
	m.mu.Unlock()
	m.rootMu.Lock()
	if m.root != nil {
		m.root.Close()
		m.root = nil
	}
	m.rootMu.Unlock()
	for _, fn := range downs {
		safe.Call("inner: on down", fn)
	}
	if !stopped {
		m.restartLoop()
	}
}

// badStarts holds the times of bad starts within restartWindow.
type badStarts []time.Time

func (b *badStarts) add(t time.Time) { *b = append(*b, t) }

// exhausted drops the starts older than restartWindow and reports whether
// more than maxBadStarts remain.
func (b *badStarts) exhausted(now time.Time) bool {
	kept := (*b)[:0]
	for _, t := range *b {
		if now.Sub(t) < restartWindow {
			kept = append(kept, t)
		}
	}
	*b = kept
	return len(kept) > maxBadStarts
}

// restartLoop starts the container again with backoff, until it is up, the
// manager stops, or the bad starts in the window run out.
func (m *Manager) restartLoop() {
	backoff := minBackoff
	for {
		m.mu.Lock()
		if m.stopped {
			m.mu.Unlock()
			return
		}
		if m.bad.exhausted(time.Now()) {
			m.lastErr = fmt.Sprintf("gave up after %d bad starts in %s: %s", len(m.bad), restartWindow, m.lastErr)
			log.Printf("inner: %s", m.lastErr)
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()

		select {
		case <-time.After(backoff):
		case <-m.stopCh:
			return
		}
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
	if m.init == nil {
		return 0
	}
	return m.init.pid
}

// Stop ends the container for good, and waits for its processes to go: for
// a poweroff.
func (m *Manager) Stop() {
	m.mu.Lock()
	if !m.stopped {
		close(m.stopCh)
	}
	m.stopped = true
	p := m.init
	m.mu.Unlock()
	if p != nil {
		p.kill()
	}
	m.watching.Wait()
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

// cleanCgroup waits for the container's processes to leave its cgroup, then
// removes the cgroups the container made, so the next one starts clean. It
// does not use cgroup.kill: on the guest kernel (6.1) a clone3 with
// CLONE_INTO_CGROUP into a cgroup that was once killed got SIGKILL before it
// could exec. The init's death ends every process in the namespace instead.
func (m *Manager) cleanCgroup() {
	deadline := time.Now().Add(killWait)
	for populated(m.cgroupDir) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if populated(m.cgroupDir) {
		log.Printf("inner: processes outlived the init by %s", killWait)
		return
	}
	removeChildren(m.cgroupDir)
	if err := os.Mkdir(filepath.Join(m.cgroupDir, "exec"), 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		log.Printf("inner: %v", err)
	}
	disableControllers(m.cgroupDir)
}

// disableControllers clears what the last init enabled in dir's
// subtree_control: a cgroup that hands controllers down takes no process, so
// the next init could not start in it (EBUSY).
func disableControllers(dir string) {
	b, err := os.ReadFile(dir + "/cgroup.subtree_control")
	if err != nil {
		return
	}
	var off []string
	for _, c := range strings.Fields(string(b)) {
		off = append(off, "-"+c)
	}
	if len(off) == 0 {
		return
	}
	if err := os.WriteFile(dir+"/cgroup.subtree_control", []byte(strings.Join(off, " ")), 0); err != nil {
		log.Printf("inner: disable %v: %v", off, err)
	}
}

func populated(dir string) bool {
	b, err := os.ReadFile(dir + "/cgroup.events")
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
