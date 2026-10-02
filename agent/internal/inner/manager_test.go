package inner

import (
	"os"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

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
// sends on inits, after gate (when set) lets each start go on.
func testManager(t *testing.T, gate <-chan struct{}) (*Manager, <-chan *fakeInit) {
	t.Helper()
	inits := make(chan *fakeInit, 16)
	m := &Manager{
		stopCh:    make(chan struct{}),
		cgroupDir: t.TempDir(),
		rootOf:    func(int) string { return t.TempDir() },
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
		t.Cleanup(f.die)
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

func TestARestartRunsOnDownThenOnUp(t *testing.T) {
	m, inits := testManager(t, nil)
	events := make(chan string, 4)
	m.OnDown(func() { events <- "down" })
	m.OnUp(func() { events <- "up" })
	m.Launch()
	first := <-inits
	if !m.Status().Up {
		t.Fatal("not up after Launch")
	}

	first.die()
	for _, want := range []string{"down", "up"} {
		select {
		case got := <-events:
			if got != want {
				t.Fatalf("hook %q, want %q", got, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("no %q hook", want)
		}
	}
	<-inits
	if st := m.Status(); !st.Up || st.Restarts != 1 {
		t.Fatalf("status %+v after a restart", st)
	}
}

func TestAStopDuringAStartKillsTheNewInit(t *testing.T) {
	gate := make(chan struct{})
	m, inits := testManager(t, gate)
	launched := make(chan struct{})
	go func() { m.Launch(); close(launched) }()
	m.Stop()
	close(gate)
	f := <-inits
	<-launched
	select {
	case <-f.killed:
	case <-time.After(5 * time.Second):
		t.Fatal("the init outlived a Stop that ran during its start")
	}
}

func TestOnlyBadStartsCountAndOldOnesExpire(t *testing.T) {
	var b badStarts
	now := time.Now()
	for i := range maxBadStarts {
		b.add(now.Add(-time.Duration(i) * time.Second))
	}
	if b.exhausted(now) {
		t.Fatalf("%d bad starts exhausted the window", maxBadStarts)
	}
	b.add(now)
	if !b.exhausted(now) {
		t.Fatalf("%d bad starts did not exhaust the window", maxBadStarts+1)
	}
	if b.exhausted(now.Add(restartWindow + time.Minute)) {
		t.Fatal("bad starts older than the window still count")
	}
	if len(b) != 0 {
		t.Fatalf("%d old bad starts kept", len(b))
	}
}
