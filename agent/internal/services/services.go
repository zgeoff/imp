// Package services supervises the long-running processes declared in
// /etc/imp/services.d/*.json. Each service restarts with exponential
// backoff (1s doubling to 60s) and logs to /var/log/imp/<name>.log, which
// rotates to <name>.log.1 past 10 MiB.
package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/safe"
)

const (
	Dir    = "/etc/imp/services.d"
	LogDir = "/var/log/imp"

	minBackoff = time.Second
	maxBackoff = 60 * time.Second
	// A run at least this long resets the backoff.
	stableAfter = 30 * time.Second
	stopGrace   = 5 * time.Second
)

// Def is one services.d file.
type Def = proto.ServiceDef

// Supervisor runs every service.
type Supervisor struct {
	runner proc.Runner
	// fsys holds services.d and the logs: the user's files
	fsys   fsroot.FS
	image  *imagecfg.Live
	dir    string
	logDir string

	// opMu serializes Add, Remove and Restart, which stop a service and
	// touch its file outside mu
	opMu sync.Mutex

	mu       sync.Mutex
	services map[string]*service
	stopping bool
	wg       sync.WaitGroup
	// quit stops the log rotator.
	quit chan struct{}

	// truncMu guards truncs: each log path's copytruncate count, so a
	// follow knows its file was emptied even when it grew back past the
	// follow's offset
	truncMu sync.Mutex
	truncs  map[string]uint64
}

type service struct {
	def Def
	// path is the services.d file the definition came from
	path     string
	state    string
	pid      int
	proc     *proc.Process
	restarts int
	lastExit *proto.Exit
	stop     chan struct{}
	// done closes when the supervisor loop returns
	done chan struct{}
	// logMu serializes rotating the log with opening it for a start.
	logMu sync.Mutex
}

// New runs services through runner, reading their files and writing their
// logs in fsys.
func New(runner proc.Runner, fsys fsroot.FS, image *imagecfg.Live) *Supervisor {
	return &Supervisor{runner: runner, fsys: fsys, image: image, dir: Dir, logDir: LogDir,
		services: make(map[string]*service), quit: make(chan struct{}),
		truncs: make(map[string]uint64)}
}

// Load reads Dir and starts every service in it, and the log rotator. A bad
// file is logged and skipped so one typo cannot keep the rest from starting.
func (s *Supervisor) Load() error {
	safe.Go("services: log rotator", func() { s.rotateLogs(s.quit) }, nil)
	return s.startAll()
}

// suspendWait bounds Suspend's wait for one supervisor loop.
const suspendWait = 5 * time.Second

// Suspend ends every service's supervision without a signal, and waits for
// the loops to finish: for a container that died, which took the services
// with it. A loop left in its backoff would otherwise start its service in
// the next container, beside the one Reload starts.
func (s *Supervisor) Suspend() {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	svcs := s.services
	s.services = make(map[string]*service)
	for _, svc := range svcs {
		if !isClosed(svc.stop) {
			close(svc.stop)
		}
	}
	s.mu.Unlock()
	deadline := time.After(suspendWait)
	for _, svc := range svcs {
		select {
		case <-svc.done:
		case <-deadline:
			log.Printf("services: %s: its supervisor did not stop in %s", svc.def.Name, suspendWait)
			return
		}
	}
}

// Reload drops every service and starts the directory's again, as a boot
// would: for a container that started again, where every service died with
// the old one.
func (s *Supervisor) Reload() error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil
	}
	for _, svc := range s.services {
		if !isClosed(svc.stop) {
			close(svc.stop)
		}
	}
	s.services = make(map[string]*service)
	s.mu.Unlock()
	return s.startAll()
}

func (s *Supervisor) startAll() error {
	ents, err := s.fsys.ReadDir(s.dir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var paths []string
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".json") {
			paths = append(paths, filepath.Join(s.dir, e.Name()))
		}
	}
	for _, p := range paths {
		def, err := readDef(s.fsys, p)
		if err != nil {
			log.Printf("services: %s: %v", p, err)
			continue
		}
		s.startAt(def, p)
	}
	return nil
}

func readDef(fsys fsroot.FS, path string) (Def, error) {
	var d Def
	b, err := fsys.ReadFile(path)
	if err != nil {
		return d, err
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return d, err
	}
	// the file name is the name: a name field could claim another service's
	d.Name = strings.TrimSuffix(filepath.Base(path), ".json")
	if d.Source != "api" {
		d.Source = "image"
	}
	return d, checkDef(&d)
}

// checkDef rejects a definition the supervisor cannot run, and fills in the
// default restart policy.
func checkDef(d *Def) error {
	if len(d.Argv) == 0 {
		return fmt.Errorf("argv is empty")
	}
	switch d.Restart {
	case "":
		d.Restart = "always"
	case "always", "on-failure", "never":
	default:
		return fmt.Errorf("restart %q: want always, on-failure or never", d.Restart)
	}
	return nil
}

// Start supervises def. A service with the same name is left alone.
func (s *Supervisor) Start(def Def) {
	s.startAt(def, "")
}

func (s *Supervisor) startAt(def Def, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.services[def.Name] != nil {
		return
	}
	svc := &service{def: def, path: path, state: "starting",
		stop: make(chan struct{}), done: make(chan struct{})}
	s.services[def.Name] = svc
	s.wg.Add(1)
	// A panic in the supervisor loop leaves the service unsupervised, not
	// the agent dead.
	safe.Go("services: "+def.Name, func() { s.run(svc) }, func() { s.setState(svc, "exited") })
}

func (s *Supervisor) run(svc *service) {
	defer s.wg.Done()
	defer close(svc.done)
	backoff := minBackoff
	for {
		if isClosed(svc.stop) {
			s.setState(svc, "stopped")
			return
		}
		started := time.Now()
		st, err := s.once(svc)
		ran := time.Since(started)

		s.mu.Lock()
		svc.pid, svc.proc = 0, nil
		// A failed start is not an exit: last_exit keeps the previous one.
		if err != nil {
			log.Printf("services: %s: %v", svc.def.Name, err)
		} else {
			svc.lastExit = &proto.Exit{Code: st.Code, Signal: int(st.Signal)}
		}
		stopped := isClosed(svc.stop)
		failed := err != nil || st.Code != 0 || st.Signal != 0
		if stopped || !shouldRestart(svc.def.Restart, failed) {
			svc.state = "exited"
			if stopped {
				svc.state = "stopped"
			}
			s.mu.Unlock()
			return
		}
		svc.state = "backoff"
		svc.restarts++
		s.mu.Unlock()

		var wait time.Duration
		wait, backoff = nextBackoff(backoff, ran)
		select {
		case <-time.After(wait):
		case <-svc.stop:
			s.setState(svc, "stopped")
			return
		}
	}
}

// shouldRestart applies a restart policy to a run that ended by itself.
func shouldRestart(policy string, failed bool) bool {
	switch policy {
	case "never":
		return false
	case "on-failure":
		return failed
	default:
		return true
	}
}

// nextBackoff returns how long to wait before the next start, and the
// backoff after that, given the current backoff and how long the run
// lasted. A stable run resets the backoff.
func nextBackoff(cur, ran time.Duration) (wait, next time.Duration) {
	if ran >= stableAfter {
		cur = minBackoff
	}
	return cur, min(cur*2, maxBackoff)
}

// once runs the service a single time and waits for it to exit.
func (s *Supervisor) once(svc *service) (reaper.Status, error) {
	logf, err := s.openLog(svc)
	if err != nil {
		return reaper.Status{}, err
	}
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		logf.Close()
		return reaper.Status{}, err
	}
	user := svc.def.User
	if user == "" {
		user = s.image.Get().User
	}
	cwd := svc.def.Cwd
	if cwd == "" {
		cwd = "/"
	}
	p, err := s.runner.Start(proc.Spec{
		Argv:    svc.def.Argv,
		Env:     proc.Merge(s.image.Get().Env, svc.def.Env),
		Dir:     cwd,
		User:    user,
		SetHome: true,
		Files:   []*os.File{devnull, logf, logf},
	})
	devnull.Close()
	logf.Close()
	if err != nil {
		return reaper.Status{}, err
	}

	s.mu.Lock()
	svc.state, svc.pid, svc.proc = "running", p.Pid, p
	// StopAll may have run between proc.Start and here, when svc.proc was
	// still nil, so its SIGTERM missed this process. Send it now.
	if isClosed(svc.stop) {
		p.Signal(syscall.SIGTERM)
	}
	s.mu.Unlock()
	return <-p.Done, nil
}

func (s *Supervisor) logPath(svc *service) string {
	return filepath.Join(s.logDir, svc.def.Name+".log")
}

// openLog rotates the service's log if it is too big, then opens it for
// appending.
func (s *Supervisor) openLog(svc *service) (*os.File, error) {
	if err := s.fsys.MkdirAll(s.logDir, 0o755); err != nil {
		return nil, err
	}
	svc.logMu.Lock()
	defer svc.logMu.Unlock()
	path := s.logPath(svc)
	if err := rotateLog(s.fsys, path); err != nil {
		log.Printf("services: %s: rotate log: %v", svc.def.Name, err)
	}
	return s.fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
}

func (s *Supervisor) setState(svc *service, state string) {
	s.mu.Lock()
	svc.state = state
	s.mu.Unlock()
}

// List reports every service, sorted by name.
func (s *Supervisor) List() []proto.ServiceStatus {
	s.mu.Lock()
	out := make([]proto.ServiceStatus, 0, len(s.services))
	for _, svc := range s.services {
		out = append(out, proto.ServiceStatus{
			Name: svc.def.Name, State: svc.state, Pid: svc.pid,
			Restarts: svc.restarts, LastExit: svc.lastExit, Def: svc.def,
		})
	}
	s.mu.Unlock()
	// /etc/passwd is read outside mu
	for i := range out {
		out[i].Root = s.runsAsRoot(out[i].Def.User)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ImageUser is the user a service without one runs as.
func (s *Supervisor) ImageUser() string {
	return s.image.Get().User
}

// runsAsRoot resolves the user a service runs as; one the guest cannot
// resolve counts as root, so impd asks for the most it could be.
func (s *Supervisor) runsAsRoot(user string) bool {
	if user == "" {
		user = s.image.Get().User
	}
	cred, _, err := proc.LookupUserIn(s.fsys, user)
	return err != nil || cred == nil || cred.Uid == 0
}

// StopAll sends SIGTERM to every service, then SIGKILL to whatever is left
// after stopGrace, and waits for the supervisors to finish.
func (s *Supervisor) StopAll() {
	s.mu.Lock()
	if !s.stopping {
		close(s.quit)
	}
	s.stopping = true
	for _, svc := range s.services {
		if !isClosed(svc.stop) {
			close(svc.stop)
		}
		if svc.proc != nil {
			svc.proc.Signal(syscall.SIGTERM)
		}
	}
	s.mu.Unlock()

	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return
	case <-time.After(stopGrace):
	}
	s.mu.Lock()
	for _, svc := range s.services {
		if svc.proc != nil {
			svc.proc.Signal(syscall.SIGKILL)
		}
	}
	s.mu.Unlock()
	<-done
}

func isClosed(c chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}
