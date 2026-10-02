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

	"github.com/zgeoff/imp/agent/internal/reaper"
)

// Spec describes one process to start.
type Spec struct {
	Argv []string
	// Env is the full environment, KEY=VALUE.
	Env []string
	Dir string
	// User is "", "name", "uid", "name:group" or "uid:gid". Empty means root.
	User string
	// Files become fds 0, 1, 2, ... in the child.
	Files []*os.File
	// TTY makes the child a session leader with Files[0] as its controlling
	// terminal. Otherwise the child gets its own process group.
	TTY bool
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
}

// cgroupFallback logs the first spawn that could not use its cgroup.
var cgroupFallback sync.Once

// Signal sends sig to the child's process group (the child leads it).
func (p *Process) Signal(sig syscall.Signal) error {
	return syscall.Kill(-p.Pid, sig)
}

// Start resolves the user and binary, then forks through r.
func Start(r *reaper.Reaper, s Spec) (*Process, error) {
	if len(s.Argv) == 0 {
		return nil, errors.New("empty argv")
	}
	cred, _, err := LookupUser(s.User)
	if err != nil {
		return nil, err
	}
	path, err := LookPath(s.Argv[0], s.Env)
	if err != nil {
		return nil, err
	}
	dir := s.Dir
	if dir == "" {
		dir = "/"
	}
	fds := make([]uintptr, len(s.Files))
	for i, f := range s.Files {
		fds[i] = f.Fd()
	}
	sys := &syscall.SysProcAttr{Credential: cred, Setpgid: !s.TTY}
	if s.TTY {
		sys.Setsid = true
		sys.Setctty = true
		sys.Ctty = 0
	}
	if s.Cgroup != nil {
		sys.UseCgroupFD = true
		sys.CgroupFD = int(s.Cgroup.Fd())
	}
	attr := &syscall.ProcAttr{Dir: dir, Env: s.Env, Files: fds, Sys: sys}
	inCgroup := s.Cgroup != nil
	pid, done, err := r.Start(func() (int, error) {
		pid, err := syscall.ForkExec(path, s.Argv, attr)
		if err == nil || !inCgroup {
			return pid, err
		}
		// No clone3, or a cgroup gone from under us: the command still runs,
		// and a stop falls back to its process group.
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
	return &Process{Pid: pid, Done: done, InCgroup: inCgroup}, nil
}

// UserEnv returns env with HOME set to user's home from /etc/passwd. Root
// (the empty user) keeps env as is.
func UserEnv(env []string, user string) ([]string, error) {
	if user == "" {
		return env, nil
	}
	_, home, err := LookupUser(user)
	if err != nil {
		return nil, err
	}
	return Merge(env, []string{"HOME=" + home}), nil
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
