package server

import (
	"slices"
	"sync"
	"testing"
	"time"
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
