// Package proc spawns guest processes through the central reaper.
//
// It uses syscall.ForkExec, not os/exec: exec.Cmd expects its own Wait call,
// which would race with the reaper.
package proc

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/reaper"
)

// Spec describes one process to start. User, HOME and the binary resolve
// where the process starts: in the inner container, against its files.
type Spec struct {
	Argv []string
	// Env is the full environment, KEY=VALUE.
	Env []string
	// Dir is the working directory. Empty tries Workdir, then $HOME, and
	// takes the first that is a directory, else /.
	Dir     string
	Workdir string
	// User is "", "name", "uid", "name:group" or "uid:gid". Empty means root.
	User string
	// Cred, when set, replaces User (tests, with no /etc/passwd).
	Cred *syscall.Credential
	// SetHome sets HOME to User's home from /etc/passwd (not for root).
	SetHome bool
	// Files become fds 0, 1, 2, ... in the child.
	Files []*os.File
	// TTY makes the child a session leader with Files[0] as its controlling
	// terminal. Otherwise the child gets its own process group.
	TTY bool
	// Helper runs the agent binary itself, with Argv[1:] as its arguments.
	Helper bool
	// Cgroup, if set, is the directory of the cgroup v2 leaf the child is
	// born in (clone3 with CLONE_INTO_CGROUP).
	Cgroup *os.File
}

// Process is a started child.
type Process struct {
	Pid  int
	Done <-chan reaper.Status
	// InCgroup reports whether the child started in Spec.Cgroup. A spawn
	// into the cgroup that fails is retried without it.
	InCgroup bool
	ctl      control
}

// control signals a started child where it runs.
type control interface {
	// signal sends sig to pid's process group, or to pid alone. Signal 0
	// probes: an error means nothing is left to signal.
	signal(pid int, sig syscall.Signal, group bool) error
}

// cgroupFallback logs the first spawn that could not use its cgroup.
var cgroupFallback sync.Once

// Signal sends sig to the child's process group (the child leads it).
func (p *Process) Signal(sig syscall.Signal) error {
	return p.ctl.signal(p.Pid, sig, true)
}

// Kill sends SIGKILL to the child alone, never to a later process that
// reused its pid.
func (p *Process) Kill() error {
	return p.ctl.signal(p.Pid, syscall.SIGKILL, false)
}

// GroupAlive reports whether any member of the child's process group lives:
// only ESRCH means it is empty.
func (p *Process) GroupAlive() bool {
	return !errors.Is(p.ctl.signal(p.Pid, 0, true), syscall.ESRCH)
}

// NewProcess builds a Process another package started, with its own way to
// signal it.
func NewProcess(pid int, done <-chan reaper.Status, signal func(pid int, sig syscall.Signal, group bool) error) *Process {
	return &Process{Pid: pid, Done: done, ctl: controlFunc(signal)}
}

type controlFunc func(pid int, sig syscall.Signal, group bool) error

func (f controlFunc) signal(pid int, sig syscall.Signal, group bool) error { return f(pid, sig, group) }

// Runner starts processes: in this process's world (Direct), or in the
// inner container.
type Runner interface {
	Start(s Spec) (*Process, error)
}

// Direct forks children of this process through its reaper.
type Direct struct {
	Reaper *reaper.Reaper
	// Agent is the agent binary, for Helper specs. AgentFile, when set, is
	// an open fd of it that survives the path going away.
	Agent     string
	AgentFile *os.File
}

// Start resolves the user and binary, then forks through the reaper.
func (d *Direct) Start(s Spec) (*Process, error) {
	if len(s.Argv) == 0 {
		return nil, errors.New("empty argv")
	}
	cred, home := s.Cred, ""
	if cred == nil {
		var err error
		if cred, home, err = LookupUser(s.User); err != nil {
			return nil, err
		}
	}
	env := s.Env
	if s.SetHome && s.User != "" {
		env = Merge(env, []string{"HOME=" + home})
	}
	files := s.Files
	path := ""
	if s.Helper {
		path = d.Agent
		if d.AgentFile != nil {
			// the child's own fd of the binary: unmounting or replacing the
			// path inside cannot break a helper
			path = fmt.Sprintf("/proc/self/fd/%d", len(files))
			files = append(append([]*os.File{}, files...), d.AgentFile)
		}
	} else {
		var err error
		if path, err = LookPath(s.Argv[0], env); err != nil {
			return nil, err
		}
	}
	dir := s.Dir
	if dir == "" {
		dir = "/"
		for _, d := range []string{s.Workdir, Get(env, "HOME")} {
			if fi, err := os.Stat(d); d != "" && err == nil && fi.IsDir() {
				dir = d
				break
			}
		}
	}
	fds := make([]uintptr, len(files))
	for i, f := range files {
		fds[i] = f.Fd()
	}
	pidfd := -1
	sys := &syscall.SysProcAttr{Credential: cred, Setpgid: !s.TTY, PidFD: &pidfd}
	if s.TTY {
		sys.Setsid = true
		sys.Setctty = true
		sys.Ctty = 0
	}
	if s.Cgroup != nil {
		sys.UseCgroupFD = true
		sys.CgroupFD = int(s.Cgroup.Fd())
	}
	attr := &syscall.ProcAttr{Dir: dir, Env: env, Files: fds, Sys: sys}
	inCgroup := s.Cgroup != nil
	pid, done, err := d.Reaper.Start(func() (int, error) {
		pid, err := syscall.ForkExec(path, s.Argv, attr)
		if err == nil || !inCgroup {
			return pid, err
		}
		// No clone3, or a cgroup gone from under us: the command still runs,
		// and a stop falls back to its process group. An exec error (EACCES,
		// say) also lands here; its retry fails the same way, which is
		// harmless.
		sys.UseCgroupFD = false
		pid, retryErr := syscall.ForkExec(path, s.Argv, attr)
		if retryErr == nil {
			inCgroup = false
			cgroupFallback.Do(func() {
				log.Printf("proc: cannot start in a cgroup (%v); execs run without one", err)
			})
		}
		return pid, retryErr
	})
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", s.Argv[0], err)
	}
	p := newDirectProcess(pid, pidfd, done)
	p.InCgroup = inCgroup
	return p, nil
}

// newDirectProcess signals through a pidfd until the child is reaped, so a
// Kill never reaches a process that reused the pid.
func newDirectProcess(pid, pidfd int, reaped <-chan reaper.Status) *Process {
	var mu sync.Mutex
	done := make(chan reaper.Status, 1)
	go func() {
		st := <-reaped
		mu.Lock()
		if pidfd >= 0 {
			unix.Close(pidfd)
			pidfd = -1
		}
		mu.Unlock()
		done <- st
	}()
	return NewProcess(pid, done, func(pid int, sig syscall.Signal, group bool) error {
		if group {
			return syscall.Kill(-pid, sig)
		}
		mu.Lock()
		defer mu.Unlock()
		if pidfd < 0 {
			return syscall.ESRCH
		}
		return unix.PidfdSendSignal(pidfd, sig, nil, 0)
	})
}

// LookPath finds file in the PATH of env, not the agent's own PATH.
func LookPath(file string, env []string) (string, error) {
	if strings.Contains(file, "/") {
		return file, executable(file)
	}
	for _, dir := range filepath.SplitList(Get(env, "PATH")) {
		if dir == "" {
			dir = "."
		}
		p := filepath.Join(dir, file)
		if executable(p) == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s: executable file not found in $PATH", file)
}

func executable(p string) error {
	fi, err := os.Stat(p)
	if err != nil {
		return err
	}
	if fi.IsDir() || fi.Mode()&0o111 == 0 {
		return fmt.Errorf("%s: permission denied", p)
	}
	return nil
}

// Get returns the value of key in env, or "".
func Get(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == key {
			return v
		}
	}
	return ""
}

// Merge returns base with each KEY=VALUE in extra added or replaced.
func Merge(base, extra []string) []string {
	out := make([]string, 0, len(base)+len(extra))
	idx := make(map[string]int)
	for _, kv := range append(append([]string{}, base...), extra...) {
		k, _, _ := strings.Cut(kv, "=")
		if i, ok := idx[k]; ok {
			out[i] = kv
			continue
		}
		idx[k] = len(out)
		out = append(out, kv)
	}
	return out
}
