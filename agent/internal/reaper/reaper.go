// Package reaper owns every wait4 call in the agent.
//
// The agent is PID 1, so it inherits every orphan in the guest and must reap
// them. A process-wide wait4(-1) loop races with any per-child Wait, so
// nothing else in the agent may call Wait. Code that spawns a child does so
// through Reaper.Start and receives the exit status on a channel.
package reaper

import (
	"errors"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

// Status is the outcome of a reaped child.
type Status struct {
	Pid int
	// Code is the exit code, or -1 if the child died from a signal.
	Code int
	// Signal is the terminating signal, or 0 if the child exited normally.
	Signal syscall.Signal
}

func statusFrom(pid int, ws syscall.WaitStatus) Status {
	if ws.Signaled() {
		return Status{Pid: pid, Code: -1, Signal: ws.Signal()}
	}
	return Status{Pid: pid, Code: ws.ExitStatus()}
}

// Reaper reaps all children and routes exit statuses to registered waiters.
type Reaper struct {
	// mu is held across fork+register so the loop cannot reap a pid before
	// its waiter exists.
	mu      sync.Mutex
	waiters map[int]chan Status
}

// New starts the reap loop. Call it once, before any child is spawned.
func New() *Reaper {
	r := &Reaper{waiters: make(map[int]chan Status)}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGCHLD)
	go func() {
		for range sigs {
			r.reapAll()
		}
	}()
	return r
}

// Start runs start (which must fork exactly one child and return its pid)
// and registers the pid. The returned channel receives exactly one Status.
func (r *Reaper) Start(start func() (int, error)) (int, <-chan Status, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pid, err := start()
	if err != nil {
		return 0, nil, err
	}
	ch := make(chan Status, 1)
	r.waiters[pid] = ch
	return pid, ch, nil
}

// reapAll drains every exited child. SIGCHLD coalesces, so one signal may
// stand for many exits.
func (r *Reaper) reapAll() {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil || pid <= 0 {
			return
		}
		if !ws.Exited() && !ws.Signaled() {
			continue
		}
		r.mu.Lock()
		ch, ok := r.waiters[pid]
		delete(r.waiters, pid)
		r.mu.Unlock()
		// Unregistered pids are orphans reparented to PID 1; drop them.
		if ok {
			ch <- statusFrom(pid, ws)
		}
	}
}
