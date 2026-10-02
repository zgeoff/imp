package inner

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

var testReaper = reaper.New()

// pair serves a spawner in this process on one end of a socketpair and
// returns a client on the other, as the agent and the inner init talk.
func pair(t *testing.T) (*client, func()) {
	t.Helper()
	sp, err := newSocketpair()
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- serve(sp[1], &proc.Direct{Reaper: testReaper}) }()
	c := newClient(sp[0])
	if err := c.waitReady(); err != nil {
		t.Fatal(err)
	}
	go c.run()
	// The spawner's end closing is the inner init dying. Its fd stays open: its exit writers may still run, and a
	// closed number could go to the next test's socket. The real init keeps
	// fd 3 for life.
	kill := func() {
		unix.Shutdown(sp[1], unix.SHUT_RDWR)
		<-served
	}
	t.Cleanup(func() { unix.Shutdown(sp[1], unix.SHUT_RDWR) })
	return c, kill
}

func devnull(t *testing.T) *os.File {
	t.Helper()
	f, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func TestASpawnRunsWithItsFdsAndReportsItsExit(t *testing.T) {
	c, _ := pair(t)
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	p, err := c.Start(proc.Spec{
		Argv:  []string{"sh", "-c", "echo hi from $X; exit 7"},
		Env:   []string{"PATH=/usr/bin:/bin", "X=inside"},
		Files: []*os.File{devnull(t), w, w},
	})
	w.Close()
	if err != nil {
		t.Fatal(err)
	}
	out := make([]byte, 100)
	n, _ := r.Read(out)
	if got := strings.TrimSpace(string(out[:n])); got != "hi from inside" {
		t.Fatalf("output %q", got)
	}
	if st := <-p.Done; st.Code != 7 {
		t.Fatalf("status %+v, want exit 7", st)
	}
}

func TestSignalsReachTheGroupAndKillReachesOnlyTheChild(t *testing.T) {
	c, _ := pair(t)
	null := devnull(t)
	p, err := c.Start(proc.Spec{
		Argv:  []string{"sh", "-c", "sleep 30 & wait"},
		Env:   []string{"PATH=/usr/bin:/bin"},
		Files: []*os.File{null, null, null},
	})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	if st := <-p.Done; st.Signal != syscall.SIGKILL {
		t.Fatalf("status %+v", st)
	}
	if err := p.Kill(); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("a kill after the exit = %v, want ESRCH", err)
	}
	if !p.GroupAlive() {
		t.Fatal("the sleep should keep the group alive")
	}
	if err := p.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for p.GroupAlive() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if p.GroupAlive() {
		t.Fatal("the group outlived SIGKILL")
	}
}

func TestAFailedSpawnKeepsItsErrno(t *testing.T) {
	c, _ := pair(t)
	null := devnull(t)
	_, err := c.Start(proc.Spec{Argv: []string{"/no/such/binary"}, Files: []*os.File{null, null, null}})
	if !errors.Is(err, syscall.ENOENT) {
		t.Fatalf("err = %v, want ENOENT", err)
	}
}

func TestWhenTheInitDiesEveryWaitEndsAndSpawnsFail(t *testing.T) {
	c, kill := pair(t)
	null := devnull(t)
	p, err := c.Start(proc.Spec{
		Argv:  []string{"sleep", "30"},
		Env:   []string{"PATH=/usr/bin:/bin"},
		Files: []*os.File{null, null, null},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { syscall.Kill(p.Pid, syscall.SIGKILL) })
	kill()
	select {
	case st := <-p.Done:
		if st.Signal != syscall.SIGKILL {
			t.Fatalf("status %+v, want SIGKILL", st)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the wait never ended")
	}
	<-c.Down()
	if _, err := c.Start(proc.Spec{Argv: []string{"true"}}); !errors.Is(err, ErrDown) {
		t.Fatalf("a spawn after the end: %v, want ErrDown", err)
	}
	if p.GroupAlive() {
		t.Fatal("a dead container has no live groups")
	}
}

func TestAnExitNeverOvertakesItsSpawnReply(t *testing.T) {
	c, _ := pair(t)
	null := devnull(t)
	for range 200 {
		p, err := c.Start(proc.Spec{Argv: []string{"/bin/true"}, Files: []*os.File{null, null, null}})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-p.Done:
		case <-time.After(5 * time.Second):
			t.Fatal("an exit was lost")
		}
	}
}

func TestASpawnWhoseCgroupFailsRunsOutsideItAndSaysSo(t *testing.T) {
	c, _ := pair(t)
	null := devnull(t)
	// a plain directory is no cgroup: clone3 refuses it, and the retry runs
	// the child without one
	dir, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	p, err := c.Start(proc.Spec{Argv: []string{"/bin/true"}, Files: []*os.File{null, null, null}, Cgroup: dir})
	if err != nil {
		t.Fatal(err)
	}
	if st := <-p.Done; st.Code != 0 {
		t.Fatalf("status %+v", st)
	}
	if p.InCgroup {
		t.Fatal("InCgroup for a spawn that could not use its cgroup")
	}
}

func TestACallTheInitNeverAnswersTimesOut(t *testing.T) {
	old := callTimeout
	callTimeout = 200 * time.Millisecond
	t.Cleanup(func() { callTimeout = old })
	sp, err := newSocketpair()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { unix.Close(sp[1]) })
	// a peer that reads nothing and answers nothing
	c := newClient(sp[0])
	go c.run()
	t.Cleanup(c.shut)
	started := time.Now()
	_, err = c.call(message{Op: opSignal, Pid: 1}, nil, nil)
	if !errors.Is(err, errNoAnswer) {
		t.Fatalf("err = %v, want errNoAnswer", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("the call took %s", time.Since(started))
	}
}
