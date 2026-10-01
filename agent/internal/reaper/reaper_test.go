package reaper

import (
	"strconv"
	"syscall"
	"testing"
	"time"
)

// The reap loop is process-wide, so the package shares one Reaper.
var r = New()

func forkSh(script string) func() (int, error) {
	return func() (int, error) {
		return syscall.ForkExec("/bin/sh", []string{"sh", "-c", script}, &syscall.ProcAttr{})
	}
}

func wait(t *testing.T, ch <-chan Status) Status {
	t.Helper()
	select {
	case st := <-ch:
		return st
	case <-time.After(5 * time.Second):
		t.Fatal("no status")
		return Status{}
	}
}

func TestStatus(t *testing.T) {
	tests := []struct {
		script string
		code   int
		sig    syscall.Signal
	}{
		{"exit 0", 0, 0},
		{"exit 7", 7, 0},
		{"kill -KILL $$", -1, syscall.SIGKILL},
		{"kill -TERM $$", -1, syscall.SIGTERM},
	}
	for _, tt := range tests {
		t.Run(tt.script, func(t *testing.T) {
			pid, ch, err := r.Start(forkSh(tt.script))
			if err != nil {
				t.Fatal(err)
			}
			st := wait(t, ch)
			if st != (Status{Pid: pid, Code: tt.code, Signal: tt.sig}) {
				t.Fatalf("status %+v, want code %d signal %d", st, tt.code, tt.sig)
			}
		})
	}
}

// TestCoalescedExits checks that exits sharing one SIGCHLD each reach their
// own waiter.
func TestCoalescedExits(t *testing.T) {
	chans := make([]<-chan Status, 20)
	for i := range chans {
		_, ch, err := r.Start(forkSh("exit " + strconv.Itoa(i)))
		if err != nil {
			t.Fatal(err)
		}
		chans[i] = ch
	}
	for i, ch := range chans {
		if st := wait(t, ch); st.Code != i {
			t.Errorf("child %d: code %d", i, st.Code)
		}
	}
}

// TestReapsUnregistered checks that a child with no waiter (as an orphan
// reparented to PID 1 would be) does not stay a zombie.
func TestReapsUnregistered(t *testing.T) {
	pid, err := forkSh("exit 0")()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	// kill(pid, 0) succeeds on a zombie and fails with ESRCH once reaped.
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("pid %d not reaped", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestStartError(t *testing.T) {
	_, _, err := r.Start(func() (int, error) { return 0, syscall.ENOENT })
	if err != syscall.ENOENT {
		t.Fatalf("err %v, want ENOENT", err)
	}
}
