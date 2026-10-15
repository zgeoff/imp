package exec

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"google.golang.org/protobuf/testing/protocmp"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/impz/agent/internal/cgroup"
	"github.com/zgeoff/impz/agent/internal/imagecfg"
	"github.com/zgeoff/impz/agent/internal/launch"
	"github.com/zgeoff/impz/agent/internal/proc"
	"github.com/zgeoff/impz/agent/internal/proto"
)

func TestStopTimerNeverArmsWithAZeroGrace(t *testing.T) {
	st := stopTimer{}

	st.arm(syscall.SIGTERM)

	_, ok := st.due()
	assert.Check(t, !ok, "a zero grace armed")
}

func TestStopTimerIgnoresSignalsThatDoNotStopTheCommand(t *testing.T) {
	for _, sig := range []syscall.Signal{syscall.SIGUSR1, syscall.SIGWINCH} {
		t.Run(sig.String(), func(t *testing.T) {
			st := stopTimer{grace: time.Hour}

			st.arm(sig)

			_, ok := st.due()
			assert.Check(t, !ok, "%s armed the grace", sig)
		})
	}
}

func TestStopTimerArmsTheGraceFromTheFirstStopSignal(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		st := stopTimer{grace: time.Hour}
		armed := time.Now()

		st.arm(syscall.SIGTERM)

		due, ok := st.due()
		assert.Check(t, ok, "SIGTERM did not arm the grace")
		assert.Check(t, cmp.Equal(due, armed.Add(time.Hour)))
	})
}

func TestStopTimerKeepsTheDeadlineOnALaterStopSignal(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		st := stopTimer{grace: time.Hour}
		armed := time.Now()
		st.arm(syscall.SIGTERM)
		time.Sleep(time.Minute)

		st.arm(syscall.SIGKILL)

		due, _ := st.due()
		assert.Check(t, cmp.Equal(due, armed.Add(time.Hour)), "a second stop signal moved the deadline")
	})
}

// childScript starts a group member that ignores SIGTERM and SIGUSR1 and
// writes its pid to pidFile, then runs leader in the foreground.
func childScript(pidFile, leader string) string {
	child := fmt.Sprintf(`trap "" TERM USR1; echo $$ > %s; exec sleep 300`, pidFile)
	return fmt.Sprintf("sh -c '%s' >/dev/null 2>&1 & %s", child, leader)
}

// readPid waits for a script to write its pid to pidFile.
func readPid(t *testing.T, pidFile string) int {
	t.Helper()
	var pid int
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		b, err := os.ReadFile(pidFile)
		if err != nil {
			return poll.Continue("no pid file yet: %v", err)
		}
		if pid, err = strconv.Atoi(strings.TrimSpace(string(b))); err != nil {
			return poll.Continue("pid file %q not complete yet", b)
		}
		return poll.Success()
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))
	return pid
}

// alive reports whether pid runs; a zombie has finished.
func alive(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	// pid (comm) S ...: the state follows the last ')'.
	s := string(b)
	return !strings.HasPrefix(strings.TrimSpace(s[strings.LastIndexByte(s, ')')+1:]), "Z")
}

func TestAliveReportsARunningProcess(t *testing.T) {
	assert.Check(t, alive(os.Getpid()))
}

// A zombie still holds its pid, but has finished.
func TestAliveReportsAZombieAsFinished(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	// This test binary, as the parent, never waits for its child (see
	// TestMain), so the child stays a zombie until the parent is killed.
	pid, err := syscall.ForkExec(os.Args[0], []string{os.Args[0]}, &syscall.ProcAttr{Env: []string{zombieParentEnv + "=" + pidFile}})
	assert.NilError(t, err)
	killAfter(t, pid)
	zombie := readPid(t, pidFile)

	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if alive(zombie) {
			return poll.Continue("pid %d still counts as alive", zombie)
		}
		return poll.Success()
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))

	assert.Check(t, syscall.Kill(zombie, 0), "pid %d is gone, not a zombie", zombie)
}

func killAfter(t *testing.T, pid int) {
	t.Helper()
	t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
}

func signal(t *testing.T, h *host, sig syscall.Signal) {
	t.Helper()
	b, err := proto.Marshal(&proto.Signal{Signal: int32(sig)})
	assert.NilError(t, err)
	h.send(t, proto.TypeSignal, b)
}

// A stopped command's leader exits at once; its child, which ignores
// SIGTERM, dies at the deadline, before EXIT.
func TestKillGraceKillsAChildThatIgnoresSIGTERMBeforeTheExit(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	const grace = 300 * time.Millisecond
	h := startExec(t, newManager(), &proto.Request{
		Argv:        []string{"sh", "-c", childScript(pidFile, "exec sleep 300")},
		KillGraceMs: new(uint32(grace.Milliseconds())),
	})
	h.started(t)
	child := readPid(t, pidFile)
	killAfter(t, child)

	sent := time.Now()
	signal(t, h, syscall.SIGTERM)
	_, exit := h.wait(t, 5*time.Second)
	took := time.Since(sent)

	assert.Check(t, cmp.Equal(exit.Signal, int32(syscall.SIGTERM)), "the leader's SIGTERM")
	assert.Check(t, took >= grace && took <= grace+2*time.Second, "EXIT came %s after SIGTERM, want just past the %s grace", took, grace)
	assert.Check(t, !alive(child), "child %d survived the grace", child)
}

// Without a host stop signal, a background child outlives its command, as it
// always has.
func TestKillGraceLeavesTheGroupAloneWithoutAStopSignal(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	h := startExec(t, newManager(), &proto.Request{
		Argv:        []string{"sh", "-c", childScript(pidFile, fmt.Sprintf("while [ ! -s %s ]; do sleep 0.01; done", pidFile))},
		KillGraceMs: new(uint32(50)),
	})
	h.started(t)

	_, exit := h.wait(t, 5*time.Second)
	child := readPid(t, pidFile)
	killAfter(t, child)
	// Serve has finished with the group once it returns.
	served := h.hangUp(t, time.Second)

	assert.Check(t, cmp.DeepEqual(exit, &proto.Exit{}, protocmp.Transform()))
	assert.Check(t, served, "Serve")
	assert.Check(t, alive(child), "the background child died without a stop signal")
}

// A leader that exits on SIGUSR1 leaves its child, which ignores it, alive.
func TestKillGraceDoesNotStartOnSIGUSR1(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pid")
	// the leader writes its pid once its trap is set: a SIGUSR1 before that
	// would end it by the signal's default action
	leaderFile := filepath.Join(dir, "leader")
	leader := fmt.Sprintf(`trap "exit 0" USR1; echo $$ > %s; while :; do sleep 0.05; done`, leaderFile)
	h := startExec(t, newManager(), &proto.Request{
		Argv:        []string{"sh", "-c", childScript(pidFile, leader)},
		KillGraceMs: new(uint32(50)),
	})
	h.started(t)
	child := readPid(t, pidFile)
	killAfter(t, child)
	readPid(t, leaderFile)

	signal(t, h, syscall.SIGUSR1)
	_, exit := h.wait(t, 5*time.Second)
	// Serve has finished with the group once it returns.
	served := h.hangUp(t, time.Second)

	assert.Check(t, cmp.DeepEqual(exit, &proto.Exit{}, protocmp.Transform()), "the leader's exit 0")
	assert.Check(t, served, "Serve")
	assert.Check(t, alive(child), "SIGUSR1 started the kill grace")
}

// A child that prints on its way out after the leader died gets that output
// to the host before EXIT, and EXIT does not wait out the grace once the
// group is empty.
func TestKillGraceForwardsAStoppedChildsLastOutputBeforeTheExit(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	// The child's trap sleeps five times past the drain grace before it
	// prints, so only the wait for the group lets that line through.
	m := newManager()
	m.drainGrace = 100 * time.Millisecond
	child := fmt.Sprintf(`trap "sleep 0.5; echo child-bye; exit 0" TERM; echo $$ > %s; while :; do sleep 0.05; done`, pidFile)
	h := startExec(t, m, &proto.Request{
		Argv:        []string{"sh", "-c", fmt.Sprintf("sh -c '%s' & exec sleep 300", child)},
		KillGraceMs: new(uint32(5000)),
	})
	h.started(t)
	killAfter(t, readPid(t, pidFile))

	sent := time.Now()
	signal(t, h, syscall.SIGTERM)
	out, _ := h.wait(t, 10*time.Second)
	took := time.Since(sent)

	assert.Check(t, cmp.Contains(out, "child-bye"))
	assert.Check(t, took <= 3*time.Second, "EXIT came %s after SIGTERM; the empty group should end the wait", took)
}

func TestKillGraceComesFromTheRequestClampedAndOffForATTY(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  *proto.Request
		want time.Duration
	}{
		{name: "off", req: &proto.Request{}, want: 0},
		{name: "zero", req: &proto.Request{KillGraceMs: new(uint32(0))}, want: 0},
		{name: "set", req: &proto.Request{KillGraceMs: new(uint32(2500))}, want: 2500 * time.Millisecond},
		{name: "clamped", req: &proto.Request{KillGraceMs: new(uint32(600_000))}, want: 60 * time.Second},
		// a tty's group belongs to its terminal
		{name: "tty", req: &proto.Request{Tty: new(true), KillGraceMs: new(uint32(2500))}, want: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, killGrace(tc.req), tc.want)
		})
	}
}

// STARTED carries the grace the agent will apply, and none for a tty exec,
// so the host does not count on a group kill.
func TestServeEchoesTheKillGraceInStarted(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  *proto.Request
		want *uint32
	}{
		{name: "plain", req: &proto.Request{Argv: []string{"true"}, KillGraceMs: new(uint32(2500))}, want: new(uint32(2500))},
		{name: "clamped", req: &proto.Request{Argv: []string{"true"}, KillGraceMs: new(uint32(600_000))}, want: new(uint32(60_000))},
		// left out, as an older agent leaves it out
		{name: "tty", req: &proto.Request{Argv: []string{"true"}, Tty: new(true), KillGraceMs: new(uint32(2500))}, want: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := startExec(t, newManager(), tc.req)

			f := h.next(t, 5*time.Second)

			assert.Equal(t, f.Type, proto.TypeStarted, "first frame %q", f.Payload)
			var st proto.Started
			assert.NilError(t, proto.Unmarshal(f.Payload, &st))
			assert.Check(t, cmp.DeepEqual(st.KillGraceMs, tc.want))
			h.wait(t, 5*time.Second)
		})
	}
}

// The host goes away right after its SIGTERM; the survivor still dies at
// the deadline.
func TestKillGraceStillKillsTheSurvivorAfterTheHostHangsUp(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	const grace = 300 * time.Millisecond
	child := fmt.Sprintf(`trap "" TERM HUP; echo $$ > %s; exec sleep 300`, pidFile)
	h := startExec(t, newManager(), &proto.Request{
		Argv:        []string{"sh", "-c", fmt.Sprintf("sh -c '%s' >/dev/null 2>&1 & exec sleep 300", child)},
		KillGraceMs: new(uint32(grace.Milliseconds())),
	})
	h.started(t)
	survivor := readPid(t, pidFile)
	killAfter(t, survivor)

	sent := time.Now()
	signal(t, h, syscall.SIGTERM)
	h.hangUp(t, 5*time.Second)
	took := time.Since(sent)

	assert.Check(t, !alive(survivor), "survivor %d outlived the grace after a hangup", survivor)
	assert.Check(t, took >= grace, "Serve returned %s after SIGTERM, before the %s grace", took, grace)
}

// A leaf that is not a cgroup (here a plain directory) cannot take the
// child, so the command runs without one and its leaf goes.
func TestServeRunsWithoutALeafThatCannotTakeTheChild(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "imp-exec")
	tree, err := cgroup.NewTree(parent)
	assert.NilError(t, err)
	m := NewManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil), tree)
	h := startExec(t, m, &proto.Request{Argv: []string{"echo", "ran"}, KillGraceMs: new(uint32(100))})
	h.started(t)

	out, exit := h.wait(t, 5*time.Second)

	assert.Check(t, cmp.Equal(strings.TrimSpace(out), "ran"))
	assert.Check(t, cmp.DeepEqual(exit, &proto.Exit{}, protocmp.Transform()))
	leaves, err := os.ReadDir(parent)
	assert.NilError(t, err)
	assert.Check(t, cmp.Len(leaves, 0))
}

// A strict manager refuses the exec it cannot give a leaf.
func TestServeRefusesAStrictExecWithoutACgroupTree(t *testing.T) {
	m := NewStrictManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil), nil)
	h := startExec(t, m, &proto.Request{Argv: []string{"echo", "ran"}})

	f := h.next(t, 5*time.Second)

	assert.Equal(t, f.Type, proto.TypeResponse, "first frame %q", f.Payload)
	var resp proto.ErrorResponse
	assert.NilError(t, proto.Unmarshal(f.Payload, &resp))
	assert.Assert(t, resp.Error != nil)
	assert.Check(t, cmp.Equal(resp.Error.Code, proto.ErrExecFailed))
	assert.Check(t, cmp.Contains(resp.Error.Message, "no cgroup to run in"))
}

// A leaf whose cgroup.kill cannot be written (here a plain directory) still
// gets its process group killed.
func TestKillCgroupFallsBackToTheProcessGroup(t *testing.T) {
	tree, err := cgroup.NewTree(filepath.Join(t.TempDir(), "imp-exec"))
	assert.NilError(t, err)
	g, err := tree.New()
	assert.NilError(t, err)
	t.Cleanup(func() { tree.Release(g) })
	events := filepath.Join(g.Dir().Name(), "cgroup.events")
	assert.NilError(t, os.WriteFile(events, []byte("populated 1\n"), 0o600))
	t.Cleanup(func() { os.Remove(events) })
	pid, err := syscall.ForkExec("/bin/sh", []string{"sh", "-c", `trap "" TERM; exec sleep 300`},
		&syscall.ProcAttr{Sys: &syscall.SysProcAttr{Setpgid: true}})
	assert.NilError(t, err)
	killAfter(t, pid)

	killCgroup(g, proc.NewProcess(pid, nil, func(pid int, sig syscall.Signal, group bool) error {
		if group {
			pid = -pid
		}
		return syscall.Kill(pid, sig)
	}), time.Now())

	assert.Check(t, !alive(pid), "pid %d survived a failed cgroup.kill", pid)
}
