package inner

import (
	"bufio"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

var testReaper = reaper.New()

// pair serves a spawner in this process on one end of a socketpair and
// returns a client on the other, as the agent and the inner init talk.
// kill ends the spawner, as the inner init dying would; the cleanup kills
// it too and waits for the client's read loop to end.
func pair(t *testing.T) (c *client, kill func()) {
	t.Helper()
	sp, err := newSocketpair()
	assert.NilError(t, err)
	served := make(chan error, 1)
	go func() { served <- serve(sp[1], &proc.Direct{Reaper: testReaper}) }()
	// The spawner's end shutting down is the inner init dying. Its fd stays
	// open: its exit writers may still run, and a closed number could go to
	// the next test's socket. The real init keeps fd 3 for life.
	kill = sync.OnceFunc(func() {
		unix.Shutdown(sp[1], unix.SHUT_RDWR)
		<-served
	})
	t.Cleanup(kill)
	c = newClient(sp[0])
	assert.NilError(t, c.waitReady())
	go c.run()
	t.Cleanup(func() {
		kill()
		select {
		case <-c.Down():
		case <-time.After(5 * time.Second):
			t.Error("the client's read loop did not end")
		}
	})
	return c, kill
}

func devnull(t *testing.T) *os.File {
	t.Helper()
	f, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })
	return f
}

// exitOf waits for p's exit.
func exitOf(t *testing.T, p *proc.Process) reaper.Status {
	t.Helper()
	select {
	case st := <-p.Done:
		return st
	case <-time.After(5 * time.Second):
		t.Fatalf("pid %d did not exit", p.Pid)
		return reaper.Status{}
	}
}

// startGroup starts a shell that leads a group with a background sleep, and
// returns once the sleep has forked. The cleanup kills the group.
func startGroup(t *testing.T, c *client) *proc.Process {
	t.Helper()
	null := devnull(t)
	r, w, err := os.Pipe()
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })
	p, err := c.Start(proc.Spec{
		Argv:  []string{"sh", "-c", "sleep 30 & echo forked; wait"},
		Env:   []string{"PATH=/usr/bin:/bin"},
		Files: []*os.File{null, w, null},
	})
	w.Close()
	assert.NilError(t, err)
	t.Cleanup(func() { p.Signal(syscall.SIGKILL) })
	// the echo runs after the fork of the sleep
	assert.NilError(t, r.SetReadDeadline(time.Now().Add(5*time.Second)))
	line, err := bufio.NewReader(r).ReadString('\n')
	assert.NilError(t, err)
	assert.Equal(t, line, "forked\n")
	return p
}

func TestASpawnRunsWithItsFdsAndReportsItsExit(t *testing.T) {
	c, _ := pair(t)
	r, w, err := os.Pipe()
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })

	p, err := c.Start(proc.Spec{
		Argv:  []string{"sh", "-c", "echo hi from $X; exit 7"},
		Env:   []string{"PATH=/usr/bin:/bin", "X=inside"},
		Files: []*os.File{devnull(t), w, w},
	})
	w.Close()

	assert.NilError(t, err)
	out, err := io.ReadAll(r)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(strings.TrimSpace(string(out)), "hi from inside"))
	assert.Check(t, cmp.DeepEqual(exitOf(t, p), reaper.Status{Pid: p.Pid, Code: 7}))
}

func TestKillEndsTheChildAloneAndLeavesItsGroup(t *testing.T) {
	c, _ := pair(t)
	p := startGroup(t, c)

	err := p.Kill()

	assert.NilError(t, err)
	assert.Check(t, cmp.DeepEqual(exitOf(t, p), reaper.Status{Pid: p.Pid, Code: -1, Signal: syscall.SIGKILL}))
	assert.Check(t, p.GroupAlive(), "the sleep should keep the group alive")
}

func TestAKillAfterTheExitIsESRCH(t *testing.T) {
	c, _ := pair(t)
	p := startGroup(t, c)
	assert.NilError(t, p.Kill())
	exitOf(t, p)

	err := p.Kill()

	assert.ErrorIs(t, err, syscall.ESRCH)
}

func TestASignalReachesTheGroupAfterItsLeaderExited(t *testing.T) {
	c, _ := pair(t)
	p := startGroup(t, c)
	assert.NilError(t, p.Kill())
	exitOf(t, p)

	err := p.Signal(syscall.SIGKILL)

	assert.NilError(t, err)
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if p.GroupAlive() {
			return poll.Continue("the group outlived SIGKILL")
		}
		return poll.Success()
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))
}

func TestAFailedSpawnKeepsItsErrno(t *testing.T) {
	c, _ := pair(t)
	null := devnull(t)

	_, err := c.Start(proc.Spec{Argv: []string{"/no/such/binary"}, Files: []*os.File{null, null, null}})

	assert.ErrorIs(t, err, syscall.ENOENT)
}

func TestWhenTheInitDiesEveryWaitEndsAndSpawnsFail(t *testing.T) {
	c, kill := pair(t)
	null := devnull(t)
	p, err := c.Start(proc.Spec{
		Argv:  []string{"sleep", "30"},
		Env:   []string{"PATH=/usr/bin:/bin"},
		Files: []*os.File{null, null, null},
	})
	assert.NilError(t, err)
	t.Cleanup(func() { syscall.Kill(p.Pid, syscall.SIGKILL) })

	kill()

	assert.Check(t, cmp.DeepEqual(exitOf(t, p), reaper.Status{Pid: p.Pid, Code: -1, Signal: syscall.SIGKILL}))
	select {
	case <-c.Down():
	case <-time.After(5 * time.Second):
		t.Fatal("the client never saw the socket close")
	}
	_, err = c.Start(proc.Spec{Argv: []string{"true"}})
	assert.Check(t, cmp.ErrorIs(err, ErrDown))
	assert.Check(t, !p.GroupAlive(), "a dead container has no live groups")
}

func TestASignalAfterTheInitDiedIsESRCH(t *testing.T) {
	c, kill := pair(t)
	null := devnull(t)
	p, err := c.Start(proc.Spec{
		Argv:  []string{"sleep", "30"},
		Env:   []string{"PATH=/usr/bin:/bin"},
		Files: []*os.File{null, null, null},
	})
	assert.NilError(t, err)
	t.Cleanup(func() { syscall.Kill(p.Pid, syscall.SIGKILL) })
	kill()
	select {
	case <-c.Down():
	case <-time.After(5 * time.Second):
		t.Fatal("the client never saw the socket close")
	}

	err = p.Signal(syscall.SIGTERM)

	// nothing is left in a dead container
	assert.ErrorIs(t, err, syscall.ESRCH)
}

// TestAnExitNeverOvertakesItsSpawnReply repeats a spawn of a child that
// exits at once, to catch an exit read before the waiter for it exists.
func TestAnExitNeverOvertakesItsSpawnReply(t *testing.T) {
	c, _ := pair(t)
	null := devnull(t)
	for i := range 200 {
		p, err := c.Start(proc.Spec{Argv: []string{"/bin/true"}, Files: []*os.File{null, null, null}})
		assert.NilError(t, err, "spawn %d", i)
		select {
		case <-p.Done:
		case <-time.After(5 * time.Second):
			t.Fatalf("the exit of spawn %d was lost", i)
		}
	}
}

func TestASpawnWhoseCgroupFailsRunsOutsideItAndSaysSo(t *testing.T) {
	c, _ := pair(t)
	null := devnull(t)
	// a plain directory is no cgroup: clone3 refuses it, and the retry runs
	// the child without one
	dir, err := os.Open(t.TempDir())
	assert.NilError(t, err)
	t.Cleanup(func() { dir.Close() })

	p, err := c.Start(proc.Spec{Argv: []string{"/bin/true"}, Files: []*os.File{null, null, null}, Cgroup: dir})

	assert.NilError(t, err)
	assert.Check(t, cmp.DeepEqual(exitOf(t, p), reaper.Status{Pid: p.Pid, Code: 0}))
	assert.Check(t, !p.InCgroup, "InCgroup for a spawn that could not use its cgroup")
}

func TestASpawnWithoutTheFdsItNamesIsRefused(t *testing.T) {
	c, _ := pair(t)

	// the spec names three files and none travel with it
	_, err := c.call(message{Op: opSpawn, Spec: &wireSpec{Argv: []string{"true"}, Files: 3}}, nil, nil)

	// the reply's text is the whole error: it carries no errno
	assert.Error(t, err, "a spawn needs its spec and every fd it names")
}

func TestASpawnWithoutASpecIsRefused(t *testing.T) {
	c, _ := pair(t)

	_, err := c.call(message{Op: opSpawn}, nil, nil)

	assert.Error(t, err, "a spawn needs its spec and every fd it names")
}

func TestAnUnknownOpIsRefused(t *testing.T) {
	c, _ := pair(t)

	_, err := c.call(message{Op: "reboot"}, nil, nil)

	assert.Error(t, err, "unknown op reboot")
}

func TestACallTheInitNeverAnswersTimesOut(t *testing.T) {
	old := callTimeout
	callTimeout = 200 * time.Millisecond
	t.Cleanup(func() { callTimeout = old })
	sp, err := newSocketpair()
	assert.NilError(t, err)
	t.Cleanup(func() { unix.Close(sp[1]) })
	// a peer that reads nothing and answers nothing
	c := newClient(sp[0])
	go c.run()
	t.Cleanup(c.shut)

	started := time.Now()
	_, err = c.call(message{Op: opSignal, Pid: 1}, nil, nil)
	took := time.Since(started)

	assert.Check(t, cmp.ErrorIs(err, errNoAnswer))
	assert.Check(t, took <= 2*time.Second, "the call took %s", took)
}
