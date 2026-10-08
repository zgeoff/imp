package server

import (
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"
)

// fakeIoctl records the ioctls freeze and thaw issue.
type fakeIoctl struct {
	mu    sync.Mutex
	calls []uint
}

func (f *fakeIoctl) install(t *testing.T) {
	t.Helper()
	prev := rootIoctl
	rootIoctl = func(req uint) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, req)
		return nil
	}
	t.Cleanup(func() { rootIoctl = prev })
}

func (f *fakeIoctl) get() []uint {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// The auto-thaw timer runs on synctest's fake clock: the test steps to just
// before and just past the timeout.
func TestFreezeThawsItselfWhenTheTimeoutPasses(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var f fakeIoctl
		f.install(t)
		s := &Server{}
		assert.NilError(t, s.freeze(time.Second))

		time.Sleep(time.Second - time.Nanosecond)
		synctest.Wait()
		before := f.get()
		time.Sleep(time.Nanosecond)
		synctest.Wait()

		assert.Check(t, cmp.DeepEqual(before, []uint{fiFreeze}))
		assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw}))
	})
}

func TestFreezeWithoutATimeoutThawsItselfAfterTheDefault(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var f fakeIoctl
		f.install(t)
		s := &Server{}
		assert.NilError(t, s.freeze(0))

		time.Sleep(defaultFreezeTimeout - time.Nanosecond)
		synctest.Wait()
		before := f.get()
		time.Sleep(time.Nanosecond)
		synctest.Wait()

		assert.Check(t, cmp.DeepEqual(before, []uint{fiFreeze}))
		assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw}))
	})
}

// An auto-thaw callback that fired while blocked on freezeMu, and so could
// not be stopped, must not thaw a freeze that came after it. The test runs
// the first freeze's callback itself, after the thaw and the next freeze, as
// the blocked callback would once it took the lock.
func TestStaleAutoThawLeavesALaterFreezeFrozen(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	var callbacks []func()
	prev := afterFunc
	afterFunc = func(d time.Duration, fn func()) *time.Timer {
		callbacks = append(callbacks, fn)
		return prev(d, func() {})
	}
	t.Cleanup(func() { afterFunc = prev })
	s := &Server{}
	assert.NilError(t, s.freeze(time.Millisecond))
	assert.NilError(t, s.thaw())
	assert.NilError(t, s.freeze(time.Hour))
	t.Cleanup(func() { s.thaw() })

	callbacks[0]()

	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw, fiFreeze}))
	assert.Check(t, s.frozen, "the later freeze still holds")
}

// lockWaiters reports whether a goroutine running fn is blocked taking a
// sync.Mutex, from the runtime's own stacks.
func lockWaiters(fn string) bool {
	buf := make([]byte, 1<<20)
	stacks := string(buf[:runtime.Stack(buf, true)])
	for _, g := range strings.Split(stacks, "\n\n") {
		if strings.Contains(g, fn) && strings.Contains(g, "sync.(*Mutex).Lock") {
			return true
		}
	}
	return false
}

// A timer that fires while freezeMu is held waits for the lock, then finds
// its freeze thawed and a new one in place, and leaves the new one frozen.
func TestAutoThawThatFiresWhileTheLockIsHeldWaitsAndThenLeavesALaterFreeze(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	var callbacks []func()
	prev := afterFunc
	afterFunc = func(d time.Duration, fn func()) *time.Timer {
		callbacks = append(callbacks, fn)
		return prev(time.Hour, func() {})
	}
	t.Cleanup(func() { afterFunc = prev })
	s := &Server{}
	assert.NilError(t, s.freeze(time.Millisecond))
	t.Cleanup(func() { s.thaw() })
	autoThaw := callbacks[0]
	s.freezeMu.Lock()
	fired := make(chan struct{})
	// the timer fires: its callback runs on a goroutine of its own
	go func() {
		defer close(fired)
		autoThaw()
	}()
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if lockWaiters("server.(*Server).freeze.func1") {
			return poll.Success()
		}
		return poll.Continue("the callback is not waiting on freezeMu yet")
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(time.Millisecond))

	thawErr := s.thawLocked()
	s.freezeMu.Unlock()
	freezeErr := s.freeze(time.Hour)
	select {
	case <-fired:
	case <-time.After(5 * time.Second):
		t.Fatal("the callback never took the lock")
	}

	assert.Check(t, thawErr)
	assert.Check(t, freezeErr)
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw, fiFreeze}))
	assert.Check(t, s.frozen, "the later freeze still holds")
}

func TestFreezeRefusesASecondFreezeAsFrozen(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	assert.NilError(t, s.freeze(time.Hour))
	t.Cleanup(func() { s.thaw() })

	err := s.freeze(time.Hour)

	assert.Check(t, cmp.ErrorIs(err, errFrozen))
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze}), "the refused freeze issued no ioctl")
}

func TestThawThawsASecondFreeze(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	assert.NilError(t, s.freeze(time.Hour))
	assert.NilError(t, s.thaw())
	assert.NilError(t, s.freeze(time.Hour))

	err := s.thaw()

	assert.Check(t, err)
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw, fiFreeze, fiThaw}))
	assert.Check(t, !s.frozen, "the second freeze still holds")
}

func TestFreezeSucceedsAgainAfterAThaw(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	assert.NilError(t, s.freeze(time.Hour))
	assert.NilError(t, s.thaw())

	err := s.freeze(time.Hour)
	t.Cleanup(func() { s.thaw() })

	assert.Check(t, cmp.Nil(err))
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw, fiFreeze}))
}

// EBUSY is a filesystem frozen from inside the guest.
func TestFreezeOfARootFrozenInTheGuestIsFrozen(t *testing.T) {
	prev := rootIoctl
	rootIoctl = func(uint) error { return unix.EBUSY }
	t.Cleanup(func() { rootIoctl = prev })

	err := (&Server{}).freeze(time.Hour)

	assert.ErrorIs(t, err, errFrozen)
}

func TestFreezeReportsAnotherIoctlFailure(t *testing.T) {
	prev := rootIoctl
	rootIoctl = func(uint) error { return unix.EPERM }
	t.Cleanup(func() { rootIoctl = prev })
	s := &Server{}

	err := s.freeze(time.Hour)

	assert.Check(t, cmp.ErrorIs(err, unix.EPERM))
	assert.Check(t, !s.frozen, "a failed freeze left the server frozen")
}

func TestThawOfAnUnfrozenRootIsNotAnError(t *testing.T) {
	prev := rootIoctl
	rootIoctl = func(uint) error { return unix.EINVAL }
	t.Cleanup(func() { rootIoctl = prev })

	err := (&Server{}).thaw()

	assert.NilError(t, err)
}

func TestThawForPoweroffThawsAFrozenRoot(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	assert.NilError(t, s.freeze(time.Hour))

	err := s.ThawForPoweroff()

	assert.Check(t, cmp.Nil(err))
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw}))
}

func TestFreezeAfterThawForPoweroffIsPoweringOff(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	assert.NilError(t, s.ThawForPoweroff())

	err := s.freeze(time.Hour)

	assert.Check(t, cmp.ErrorIs(err, errPoweringOff))
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiThaw}), "the refused freeze issued no ioctl")
}

// fakeGrow records the sizes grow asks the disk for.
func fakeGrow(t *testing.T) *[]int64 {
	t.Helper()
	var grown []int64
	prev := waitAndGrow
	waitAndGrow = func(_ string, target int64, _ time.Duration) error {
		grown = append(grown, target)
		return nil
	}
	t.Cleanup(func() { waitAndGrow = prev })
	return &grown
}

func TestGrowWhileFrozenIsRefusedAsFrozen(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	grown := fakeGrow(t)
	s := &Server{}
	assert.NilError(t, s.freeze(time.Minute))
	t.Cleanup(func() { s.thaw() })

	err := s.grow(1 << 30)

	assert.Check(t, cmp.ErrorIs(err, errFrozen))
	assert.Check(t, cmp.Len(*grown, 0), "the refused grow reached the disk")
}

func TestGrowAfterAThawGrowsTheDisk(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	grown := fakeGrow(t)
	s := &Server{}
	assert.NilError(t, s.freeze(time.Minute))
	assert.NilError(t, s.thaw())

	err := s.grow(1 << 30)

	assert.Check(t, cmp.Nil(err))
	assert.Check(t, cmp.DeepEqual(*grown, []int64{1 << 30}))
}
