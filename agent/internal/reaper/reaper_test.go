package reaper

import (
	"strconv"
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"
)

// The reap loop is process-wide, so the package shares one Reaper.
var r = New()

func forkSh(script string) func() (int, error) {
	return func() (int, error) {
		return syscall.ForkExec("/bin/sh", []string{"sh", "-c", script}, &syscall.ProcAttr{})
	}
}

// wait returns the status ch delivers, failing the test if none arrives.
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

func TestStartDeliversTheChildsExitStatus(t *testing.T) {
	for _, tc := range []struct {
		script string
		code   int
		sig    syscall.Signal
	}{
		{"exit 0", 0, 0},
		{"exit 7", 7, 0},
		{"kill -KILL $$", -1, syscall.SIGKILL},
		{"kill -TERM $$", -1, syscall.SIGTERM},
	} {
		t.Run(tc.script, func(t *testing.T) {
			pid, ch, err := r.Start(forkSh(tc.script))
			assert.NilError(t, err)

			st := wait(t, ch)

			assert.Equal(t, st, Status{Pid: pid, Code: tc.code, Signal: tc.sig})
		})
	}
}

// Exits that share one SIGCHLD each reach their own waiter.
func TestStartDeliversEachOfManyCoalescedExitsToItsOwnWaiter(t *testing.T) {
	chans := make([]<-chan Status, 20)
	want := make([]int, len(chans))
	for i := range chans {
		_, ch, err := r.Start(forkSh("exit " + strconv.Itoa(i)))
		assert.NilError(t, err)
		chans[i] = ch
		want[i] = i
	}

	got := make([]int, len(chans))
	for i, ch := range chans {
		got[i] = wait(t, ch).Code
	}

	assert.DeepEqual(t, got, want)
}

// A child with no waiter, as an orphan reparented to PID 1 would be, does
// not stay a zombie.
func TestTheReaperReapsAChildWithNoWaiter(t *testing.T) {
	pid, err := forkSh("exit 0")()
	assert.NilError(t, err)

	// kill(pid, 0) succeeds on a zombie and fails with ESRCH once reaped.
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		switch err := syscall.Kill(pid, 0); err {
		case nil:
			return poll.Continue("pid %d not reaped", pid)
		case syscall.ESRCH:
			return poll.Success()
		default:
			return poll.Error(err)
		}
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))
}

func TestStartReturnsTheForkError(t *testing.T) {
	_, ch, err := r.Start(func() (int, error) { return 0, syscall.ENOENT })

	assert.Check(t, cmp.ErrorIs(err, syscall.ENOENT))
	assert.Check(t, ch == nil, "a failed start returned a status channel")
}
