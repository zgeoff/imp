package inner

import (
	"os"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

// fakeInit is an inner init served in the test's own process: a spawner on
// a socketpair, with a pid nobody has and an exit the test controls.
type fakeInit struct {
	died   chan reaper.Status
	sp     int
	served chan error
	killed chan struct{}
	once   sync.Once
}

func (f *fakeInit) die() {
	f.once.Do(func() {
		unix.Shutdown(f.sp, unix.SHUT_RDWR)
		<-f.served
		f.died <- reaper.Status{Code: -1, Signal: syscall.SIGKILL}
	})
}

// testManager returns a manager whose starts make fake inits, which it
// sends on inits, after gate (when set) lets each start go on. Its cleanup
// stops the manager, then ends every fake init it made.
func testManager(t *testing.T, gate <-chan struct{}) (*Manager, <-chan *fakeInit) {
	t.Helper()
	inits := make(chan *fakeInit, 16)
	var mu sync.Mutex
	var made []*fakeInit
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		for _, f := range made {
			f.die()
		}
	})
	// every start opens the same root: the manager's restarts run off the
	// test goroutine, where t.TempDir cannot fail the test
	root := t.TempDir()
	m := &Manager{
		stopCh:    make(chan struct{}),
		cgroupDir: t.TempDir(),
		rootOf:    func(int) string { return root },
	}
	m.startInit = func(*os.File) (*initProc, error) {
		if gate != nil {
			<-gate
		}
		pair, err := newSocketpair()
		if err != nil {
			return nil, err
		}
		f := &fakeInit{died: make(chan reaper.Status, 1), sp: pair[1], served: make(chan error, 1), killed: make(chan struct{})}
		go func() { f.served <- serve(pair[1], &proc.Direct{Reaper: testReaper}) }()
		mu.Lock()
		made = append(made, f)
		mu.Unlock()
		inits <- f
		return newInitProc(1<<22, pair[0], f.died, func() error {
			close(f.killed)
			go f.die()
			return nil
		}, func() {}), nil
	}
	t.Cleanup(m.Stop)
	return m, inits
}

// receive waits for one value on ch, failing the test after within.
func receive[T any](t *testing.T, ch <-chan T, within time.Duration, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(within):
		t.Fatalf("no %s after %s", what, within)
		var zero T
		return zero
	}
}

func TestLaunchBringsTheContainerUp(t *testing.T) {
	m, inits := testManager(t, nil)

	m.Launch()

	receive(t, inits, 5*time.Second, "init")
	assert.DeepEqual(t, m.Status(), Status{Up: true})
}

func TestARestartRunsOnDownThenOnUp(t *testing.T) {
	m, inits := testManager(t, nil)
	events := make(chan string, 4)
	m.OnDown(func() { events <- "down" })
	m.OnUp(func() { events <- "up" })
	m.Launch()
	first := receive(t, inits, 5*time.Second, "init")

	first.die()

	// the restart waits out minBackoff
	got := []string{
		receive(t, events, 10*time.Second, "hook"),
		receive(t, events, 10*time.Second, "hook"),
	}
	assert.DeepEqual(t, got, []string{"down", "up"})
	receive(t, inits, 5*time.Second, "second init")
	assert.DeepEqual(t, m.Status(), Status{Up: true, Restarts: 1})
}

func TestAStopDuringAStartKillsTheNewInit(t *testing.T) {
	gate := make(chan struct{})
	m, inits := testManager(t, gate)
	launched := make(chan struct{})
	go func() { m.Launch(); close(launched) }()

	m.Stop()
	close(gate)

	f := receive(t, inits, 5*time.Second, "init")
	receive(t, launched, 5*time.Second, "end of Launch")
	select {
	case <-f.killed:
	case <-time.After(5 * time.Second):
		t.Fatal("the init outlived a Stop that ran during its start")
	}
}

func TestManagerStartIsErrDownWhileNoContainerRuns(t *testing.T) {
	m, _ := testManager(t, nil)

	_, err := m.Start(proc.Spec{Argv: []string{"true"}})

	assert.ErrorIs(t, err, ErrDown)
}

func TestManagerRootIsErrDownWhileNoContainerRuns(t *testing.T) {
	m, _ := testManager(t, nil)

	_, err := m.Root().ReadFile("etc/passwd")

	assert.ErrorIs(t, err, ErrDown)
}

func TestBadStartsAreNotExhaustedAtTheLimit(t *testing.T) {
	var b badStarts
	now := time.Now()
	for i := range maxBadStarts {
		b.add(now.Add(-time.Duration(i) * time.Second))
	}

	assert.Assert(t, !b.exhausted(now), "%d bad starts exhausted the window", maxBadStarts)
}

func TestBadStartsAreExhaustedPastTheLimit(t *testing.T) {
	var b badStarts
	now := time.Now()
	for i := range maxBadStarts + 1 {
		b.add(now.Add(-time.Duration(i) * time.Second))
	}

	assert.Assert(t, b.exhausted(now), "%d bad starts did not exhaust the window", maxBadStarts+1)
}

func TestBadStartsOlderThanTheWindowExpire(t *testing.T) {
	var b badStarts
	now := time.Now()
	for i := range maxBadStarts + 1 {
		b.add(now.Add(-time.Duration(i) * time.Second))
	}

	exhausted := b.exhausted(now.Add(restartWindow + time.Minute))

	assert.Check(t, !exhausted, "bad starts older than the window still count")
	assert.Check(t, len(b) == 0, "%d old bad starts kept", len(b))
}
