package server

import (
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// fakeIoctl records the ioctls freeze and thaw issue.
type fakeIoctl struct {
	mu    sync.Mutex
	calls []uint
}

func (f *fakeIoctl) install(t *testing.T) {
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

func TestFreezeAutoThaws(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	if err := s.freeze(time.Millisecond); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(f.get()) < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got, want := f.get(), []uint{fiFreeze, fiThaw}; !slices.Equal(got, want) {
		t.Fatalf("ioctls = %#x, want %#x", got, want)
	}
}

// TestStaleAutoThaw checks that a timer which fired while blocked on
// freezeMu does not thaw a freeze that came after it.
func TestStaleAutoThaw(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	if err := s.freeze(time.Millisecond); err != nil {
		t.Fatal(err)
	}
	// Hold the lock past the timeout so the callback fires and waits.
	s.freezeMu.Lock()
	time.Sleep(20 * time.Millisecond)
	if err := s.thawLocked(); err != nil {
		t.Fatal(err)
	}
	s.freezeMu.Unlock()
	if err := s.freeze(time.Hour); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if got, want := f.get(), []uint{fiFreeze, fiThaw, fiFreeze}; !slices.Equal(got, want) {
		t.Fatalf("ioctls = %#x, want %#x", got, want)
	}
	if err := s.thaw(); err != nil {
		t.Fatal(err)
	}
}

func TestFreezeTwiceIsFrozen(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	if err := s.freeze(time.Hour); err != nil {
		t.Fatal(err)
	}
	var pe *proto.Error
	if err := s.freeze(time.Hour); !errors.As(err, &pe) || pe.Code != proto.ErrFrozen {
		t.Fatalf("second freeze = %v, want FROZEN", err)
	}
	if err := s.thaw(); err != nil {
		t.Fatal(err)
	}
	if err := s.freeze(time.Hour); err != nil {
		t.Fatalf("freeze after thaw = %v", err)
	}
	if err := s.thaw(); err != nil {
		t.Fatal(err)
	}
	if got, want := f.get(), []uint{fiFreeze, fiThaw, fiFreeze, fiThaw}; !slices.Equal(got, want) {
		t.Fatalf("ioctls = %#x, want %#x", got, want)
	}
}

// TestFreezeBusyIsFrozen covers a filesystem frozen from inside the guest.
func TestFreezeBusyIsFrozen(t *testing.T) {
	prev := rootIoctl
	rootIoctl = func(uint) error { return unix.EBUSY }
	t.Cleanup(func() { rootIoctl = prev })
	var pe *proto.Error
	if err := (&Server{}).freeze(time.Hour); !errors.As(err, &pe) || pe.Code != proto.ErrFrozen {
		t.Fatalf("freeze = %v, want FROZEN", err)
	}
}

func TestThawForPoweroff(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	if err := s.freeze(time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := s.ThawForPoweroff(); err != nil {
		t.Fatal(err)
	}
	var pe *proto.Error
	if err := s.freeze(time.Hour); !errors.As(err, &pe) || pe.Code != proto.ErrPoweringOff {
		t.Fatalf("freeze after ThawForPoweroff = %v, want POWERING_OFF", err)
	}
	if got, want := f.get(), []uint{fiFreeze, fiThaw}; !slices.Equal(got, want) {
		t.Fatalf("ioctls = %#x, want %#x", got, want)
	}
}

func TestGrowRefusedWhileFrozen(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	var grown []int64
	prev := waitAndGrow
	waitAndGrow = func(_ string, target int64, _ time.Duration) error {
		grown = append(grown, target)
		return nil
	}
	t.Cleanup(func() { waitAndGrow = prev })
	s := &Server{}
	if err := s.freeze(time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := s.grow(1 << 30); !errors.Is(err, errFrozen) {
		t.Fatalf("grow while frozen = %v, want FROZEN", err)
	}
	if err := s.thaw(); err != nil {
		t.Fatal(err)
	}
	if err := s.grow(1 << 30); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(grown, []int64{1 << 30}) {
		t.Fatalf("grown = %v, want one grow after the thaw", grown)
	}
}
