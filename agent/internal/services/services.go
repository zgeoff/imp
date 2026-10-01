// Package services supervises the long-running processes declared in
// /etc/imp/services.d/*.json. Each service restarts with exponential
// backoff (1s doubling to 60s) and logs to /var/log/imp/<name>.log.
package services

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
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

// Def is one services.d file. Name defaults to the file name without .json.
type Def struct {
	Name string   `json:"name"`
	Argv []string `json:"argv"`
	Env  []string `json:"env"`
	Cwd  string   `json:"cwd"`
	User string   `json:"user"`
	// Restart is "always" (default), "on-failure" or "never".
	Restart string `json:"restart"`
}

// Supervisor runs every service.
type Supervisor struct {
	reaper *reaper.Reaper
	image  imagecfg.Config

	mu       sync.Mutex
	services map[string]*service
	stopping bool
	wg       sync.WaitGroup
}

type service struct {
	def      Def
	state    string
	pid      int
	proc     *proc.Process
	restarts int
	lastExit *proto.Exit
	stop     chan struct{}
}

func New(r *reaper.Reaper, image imagecfg.Config) *Supervisor {
	return &Supervisor{reaper: r, image: image, services: make(map[string]*service)}
}

// Load reads Dir and starts every service in it. A bad file is logged and
// skipped so one typo cannot keep the rest from starting.
func (s *Supervisor) Load() error {
	paths, err := filepath.Glob(filepath.Join(Dir, "*.json"))
	if err != nil {
		return err
	}
	for _, p := range paths {
		def, err := readDef(p)
		if err != nil {
			log.Printf("services: %s: %v", p, err)
			continue
		}
		s.Start(def)
	}
	return nil
}

func readDef(path string) (Def, error) {
	var d Def
	b, err := os.ReadFile(path)
	if err != nil {
		return d, err
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return d, err
	}
	if d.Name == "" {
		d.Name = strings.TrimSuffix(filepath.Base(path), ".json")
	}
	if len(d.Argv) == 0 {
		return d, fmt.Errorf("argv is empty")
	}
	switch d.Restart {
	case "":
		d.Restart = "always"
	case "always", "on-failure", "never":
	default:
		return d, fmt.Errorf("restart %q: want always, on-failure or never", d.Restart)
	}
	return d, nil
}

// Start supervises def. A service with the same name is left alone.
func (s *Supervisor) Start(def Def) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.services[def.Name] != nil {
		return
	}
	svc := &service{def: def, state: "starting", stop: make(chan struct{})}
	s.services[def.Name] = svc
	s.wg.Add(1)
	go s.run(svc)
}

func (s *Supervisor) run(svc *service) {
	defer s.wg.Done()
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
		if err != nil {
			log.Printf("services: %s: %v", svc.def.Name, err)
			svc.lastExit = nil
		} else {
			svc.lastExit = &proto.Exit{Code: st.Code, Signal: int(st.Signal)}
		}
		stopped := isClosed(svc.stop)
		failed := err != nil || st.Code != 0 || st.Signal != 0
		if stopped || svc.def.Restart == "never" || (svc.def.Restart == "on-failure" && !failed) {
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

		if ran >= stableAfter {
			backoff = minBackoff
		}
		select {
		case <-time.After(backoff):
		case <-svc.stop:
			s.setState(svc, "stopped")
			return
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// once runs the service a single time and waits for it to exit.
func (s *Supervisor) once(svc *service) (reaper.Status, error) {
	if err := os.MkdirAll(LogDir, 0o755); err != nil {
		return reaper.Status{}, err
	}
	logf, err := os.OpenFile(filepath.Join(LogDir, svc.def.Name+".log"),
		os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
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
		user = s.image.User
	}
	cwd := svc.def.Cwd
	if cwd == "" {
		cwd = "/"
	}
	env, err := proc.UserEnv(proc.Merge(s.image.Env, svc.def.Env), user)
	if err != nil {
		devnull.Close()
		logf.Close()
		return reaper.Status{}, err
	}
	p, err := proc.Start(s.reaper, proc.Spec{
		Argv:  svc.def.Argv,
		Env:   env,
		Dir:   cwd,
		User:  user,
		Files: []*os.File{devnull, logf, logf},
	})
	devnull.Close()
	logf.Close()
	if err != nil {
		return reaper.Status{}, err
	}

	s.mu.Lock()
	svc.state, svc.pid, svc.proc = "running", p.Pid, p
	s.mu.Unlock()
	return <-p.Done, nil
}

func (s *Supervisor) setState(svc *service, state string) {
	s.mu.Lock()
	svc.state = state
	s.mu.Unlock()
}

// List reports every service, sorted by name.
func (s *Supervisor) List() []proto.ServiceStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]proto.ServiceStatus, 0, len(s.services))
	for _, svc := range s.services {
		out = append(out, proto.ServiceStatus{
			Name: svc.def.Name, State: svc.state, Pid: svc.pid,
			Restarts: svc.restarts, LastExit: svc.lastExit,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// StopAll sends SIGTERM to every service, then SIGKILL to whatever is left
// after stopGrace, and waits for the supervisors to finish.
func (s *Supervisor) StopAll() {
	s.mu.Lock()
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
