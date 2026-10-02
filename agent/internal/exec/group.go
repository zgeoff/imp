package exec

import (
	"log"
	"sync"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/cgroup"
	"github.com/zgeoff/imp/agent/internal/proto"
)

// groupPoll is how often a stopping group is checked for members.
const groupPoll = 20 * time.Millisecond

// groupKillWait bounds the wait for a group to empty after its SIGKILL. A
// member in uninterruptible sleep (D state) can outlast it, and the exit
// must not wait on it for good.
const groupKillWait = 5 * time.Second

// maxKillGrace caps kill_grace_ms, as the host's API does.
const maxKillGrace = 60 * time.Second

// killGrace is the request's kill grace, clamped to maxKillGrace; 0 (off)
// for a tty exec, whose group belongs to its terminal and is not the
// host's to sweep.
func killGrace(req proto.Request) time.Duration {
	if req.TTY || req.KillGraceMs <= 0 {
		return 0
	}
	return min(time.Duration(req.KillGraceMs)*time.Millisecond, maxKillGrace)
}

// isStopSignal reports whether a host signal asks the command to stop. Only
// these start the kill grace; SIGUSR1 and the like are ordinary messages
// to the command.
func isStopSignal(sig syscall.Signal) bool {
	switch sig {
	case syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT, syscall.SIGKILL:
		return true
	}
	return false
}

// stopTimer records when the rest of a stopped command's group is due for
// SIGKILL: the first host stop signal plus the exec's kill grace.
type stopTimer struct {
	grace time.Duration

	mu       sync.Mutex
	deadline time.Time
}

// arm starts the grace on the first stop signal; later ones do not extend it.
func (t *stopTimer) arm(sig syscall.Signal) {
	if t.grace <= 0 || !isStopSignal(sig) {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.deadline.IsZero() {
		t.deadline = time.Now().Add(t.grace)
	}
}

// due returns the deadline, and false if no stop signal arrived.
func (t *stopTimer) due() (time.Time, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.deadline, !t.deadline.IsZero()
}

// killGroup waits for the process group pgid to empty until deadline, then
// SIGKILLs what is left and waits up to groupKillWait for that to go.
//
// The leader is reaped by now, but its pid cannot have gone to another
// process: Linux keeps a pid allocated while it is any live process's
// process group id. So while one member is left, -pgid is still this
// group, and no WNOWAIT trick to hold the leader's zombie is needed. Once
// the group is empty, kill finds nothing (ESRCH) and the wait ends.
func killGroup(pgid int, deadline time.Time) {
	if waitGroupEmpty(pgid, deadline) {
		return
	}
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil {
		return
	}
	if !waitGroupEmpty(pgid, time.Now().Add(groupKillWait)) {
		log.Printf("exec: process group %d outlived SIGKILL by %s; sending the exit anyway", pgid, groupKillWait)
	}
}

// killCgroup waits for g to empty until deadline, then kills what is left
// with cgroup.kill and waits up to groupKillWait for that to go. It reaches
// the members that left the process group (setsid, a double fork); they get
// no SIGTERM first, only the kill at the deadline. If cgroup.kill fails, the
// process group pgid still gets its SIGKILL.
func killCgroup(g *cgroup.Group, pgid int, deadline time.Time) {
	if g.WaitEmpty(deadline) {
		return
	}
	if err := g.Kill(); err != nil {
		log.Printf("exec: cgroup.kill: %v; killing the process group instead", err)
		killGroup(pgid, deadline)
		return
	}
	if !g.WaitEmpty(time.Now().Add(groupKillWait)) {
		log.Printf("exec: a cgroup outlived cgroup.kill by %s; sending the exit anyway", groupKillWait)
	}
}

// waitGroupEmpty polls until the group has no members or deadline passes,
// and reports whether it emptied.
func waitGroupEmpty(pgid int, deadline time.Time) bool {
	for {
		if syscall.Kill(-pgid, 0) == syscall.ESRCH {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(min(groupPoll, time.Until(deadline)))
	}
}
