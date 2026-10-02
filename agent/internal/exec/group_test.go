package exec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/cgroup"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
)

func TestStopTimer(t *testing.T) {
	off := stopTimer{}
	off.arm(syscall.SIGTERM)
	if _, ok := off.due(); ok {
		t.Fatal("a zero grace armed")
	}

	st := stopTimer{grace: time.Hour}
	st.arm(syscall.SIGUSR1)
	st.arm(syscall.SIGWINCH)
	if _, ok := st.due(); ok {
		t.Fatal("SIGUSR1 or SIGWINCH armed the grace")
	}
	before := time.Now()
	st.arm(syscall.SIGTERM)
	first, ok := st.due()
	if !ok || first.Before(before.Add(time.Hour)) {
		t.Fatalf("due = %v, %v after SIGTERM", first, ok)
	}
	time.Sleep(time.Millisecond)
	st.arm(syscall.SIGKILL)
	if again, _ := st.due(); !again.Equal(first) {
		t.Fatal("a second stop signal moved the deadline")
	}
}

// childScript starts a group member that ignores SIGTERM and SIGUSR1 and
// writes its pid to pidFile, then runs leader in the foreground.
func childScript(pidFile, leader string) string {
	child := fmt.Sprintf(`trap "" TERM USR1; echo $$ > %s; exec sleep 300`, pidFile)
	return fmt.Sprintf("sh -c '%s' >/dev/null 2>&1 & %s", child, leader)
}

func readPid(t *testing.T, pidFile string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				return pid
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the child never wrote its pid")
	return 0
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

func killAfter(t *testing.T, pid int) {
	t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
}

func signal(t *testing.T, h *host, sig syscall.Signal) {
	t.Helper()
	b, _ := json.Marshal(proto.Signal{Signal: int(sig)})
	h.send(t, proto.TypeSignal, b)
}

// TestKillGraceKillsSurvivor stops a command whose child ignores SIGTERM:
// the leader exits at once, the child dies at the deadline, before EXIT.
func TestKillGraceKillsSurvivor(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	const grace = 300 * time.Millisecond
	h := startExec(t, newManager(), proto.Request{
		Argv:        []string{"sh", "-c", childScript(pidFile, "exec sleep 300")},
		KillGraceMs: grace.Milliseconds(),
	})
	h.started(t)
	child := readPid(t, pidFile)
	killAfter(t, child)

	sent := time.Now()
	signal(t, h, syscall.SIGTERM)
	_, exit := h.wait(t, 5*time.Second)
	took := time.Since(sent)

	if exit.Signal != int(syscall.SIGTERM) {
		t.Fatalf("exit = %+v, want the leader's SIGTERM", exit)
	}
	if took < grace || took > grace+2*time.Second {
		t.Fatalf("EXIT came %s after SIGTERM, want just past the %s grace", took, grace)
	}
	if alive(child) {
		t.Fatalf("child %d survived the grace", child)
	}
}

// TestNoStopLeavesGroup: without a host signal, a background child outlives
// its command, as it always has.
func TestNoStopLeavesGroup(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	h := startExec(t, newManager(), proto.Request{
		Argv:        []string{"sh", "-c", childScript(pidFile, fmt.Sprintf("while [ ! -s %s ]; do sleep 0.01; done", pidFile))},
		KillGraceMs: 50,
	})
	h.started(t)
	if _, exit := h.wait(t, 5*time.Second); exit.Code != 0 {
		t.Fatalf("exit = %+v", exit)
	}
	child := readPid(t, pidFile)
	killAfter(t, child)
	time.Sleep(200 * time.Millisecond)
	if !alive(child) {
		t.Fatal("the background child died without a stop signal")
	}
}

// TestSIGUSR1DoesNotArm: a leader that exits on SIGUSR1 leaves its child,
// which ignores it, alive.
func TestSIGUSR1DoesNotArm(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	h := startExec(t, newManager(), proto.Request{
		Argv:        []string{"sh", "-c", childScript(pidFile, `trap "exit 0" USR1; while :; do sleep 0.05; done`)},
		KillGraceMs: 50,
	})
	h.started(t)
	child := readPid(t, pidFile)
	killAfter(t, child)

	signal(t, h, syscall.SIGUSR1)
	if _, exit := h.wait(t, 5*time.Second); exit.Code != 0 {
		t.Fatalf("exit = %+v, want the leader's exit 0", exit)
	}
	time.Sleep(200 * time.Millisecond)
	if !alive(child) {
		t.Fatal("SIGUSR1 started the kill grace")
	}
}

// TestKillGraceOutputBeforeExit: a child that prints on its way out after
// the leader died gets that output to the host before EXIT, and EXIT does
// not wait out the grace once the group is empty.
func TestKillGraceOutputBeforeExit(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	child := fmt.Sprintf(`trap "sleep 0.7; echo child-bye; exit 0" TERM; echo $$ > %s; while :; do sleep 0.05; done`, pidFile)
	h := startExec(t, newManager(), proto.Request{
		Argv:        []string{"sh", "-c", fmt.Sprintf("sh -c '%s' & exec sleep 300", child)},
		KillGraceMs: 5000,
	})
	h.started(t)
	killAfter(t, readPid(t, pidFile))

	sent := time.Now()
	signal(t, h, syscall.SIGTERM)
	out, _ := h.wait(t, 10*time.Second)
	took := time.Since(sent)

	// Past drainGrace: without the group wait, the drain would cut it off.
	if !strings.Contains(out, "child-bye") {
		t.Fatalf("output %q lacks the child's last line", out)
	}
	if took > 3*time.Second {
		t.Fatalf("EXIT came %s after SIGTERM; the empty group should end the wait", took)
	}
}

func TestKillGrace(t *testing.T) {
	tests := []struct {
		name string
		req  proto.Request
		want time.Duration
	}{
		{"off", proto.Request{}, 0},
		{"negative", proto.Request{KillGraceMs: -5}, 0},
		{"set", proto.Request{KillGraceMs: 2500}, 2500 * time.Millisecond},
		{"clamped", proto.Request{KillGraceMs: 600_000}, maxKillGrace},
		// a tty's group belongs to its terminal
		{"tty", proto.Request{TTY: true, KillGraceMs: 2500}, 0},
	}
	for _, tt := range tests {
		if got := killGrace(tt.req); got != tt.want {
			t.Errorf("%s: killGrace = %s, want %s", tt.name, got, tt.want)
		}
	}
}

// TestStartedEchoesGrace: STARTED carries the grace the agent will apply,
// and none for a tty exec, so the host does not count on a group kill.
func TestStartedEchoesGrace(t *testing.T) {
	tests := []struct {
		name string
		req  proto.Request
		want int64
	}{
		{"plain", proto.Request{Argv: []string{"true"}, KillGraceMs: 2500}, 2500},
		{"clamped", proto.Request{Argv: []string{"true"}, KillGraceMs: 600_000}, maxKillGrace.Milliseconds()},
		{"tty", proto.Request{Argv: []string{"true"}, TTY: true, KillGraceMs: 2500}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := startExec(t, newManager(), tt.req)
			f := h.next(t, 5*time.Second)
			var st proto.Started
			if f.Type != proto.TypeStarted || json.Unmarshal(f.Payload, &st) != nil {
				t.Fatalf("first frame %s %q", f.Type, f.Payload)
			}
			if st.KillGraceMs != tt.want {
				t.Fatalf("kill_grace_ms = %d, want %d", st.KillGraceMs, tt.want)
			}
			h.wait(t, 5*time.Second)
		})
	}
}

// TestHangupDuringGrace: the host goes away right after its SIGTERM; the
// survivor still dies at the deadline.
func TestHangupDuringGrace(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	const grace = 300 * time.Millisecond
	child := fmt.Sprintf(`trap "" TERM HUP; echo $$ > %s; exec sleep 300`, pidFile)
	h := startExec(t, newManager(), proto.Request{
		Argv:        []string{"sh", "-c", fmt.Sprintf("sh -c '%s' >/dev/null 2>&1 & exec sleep 300", child)},
		KillGraceMs: grace.Milliseconds(),
	})
	h.started(t)
	survivor := readPid(t, pidFile)
	killAfter(t, survivor)

	sent := time.Now()
	signal(t, h, syscall.SIGTERM)
	h.conn.Close()
	select {
	case <-h.served:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after the hangup")
	}
	if alive(survivor) {
		t.Fatalf("survivor %d outlived the grace after a hangup", survivor)
	}
	if took := time.Since(sent); took < grace {
		t.Fatalf("Serve returned %s after SIGTERM, before the %s grace", took, grace)
	}
}

// TestCgroupSpawnFallsBack: a leaf that is not a cgroup (here a plain
// directory) cannot take the child, so the command runs without one and its
// leaf goes.
func TestCgroupSpawnFallsBack(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "imp-exec")
	tree, err := cgroup.NewTree(parent)
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil), tree)
	h := startExec(t, m, proto.Request{Argv: []string{"echo", "ran"}, KillGraceMs: 100})
	h.started(t)
	out, exit := h.wait(t, 5*time.Second)
	if exit.Code != 0 || strings.TrimSpace(out) != "ran" {
		t.Fatalf("exit = %+v, output %q", exit, out)
	}
	leaves, _ := os.ReadDir(parent)
	if len(leaves) != 0 || tree.Ended() != 0 {
		t.Fatalf("leaves left: %v, ended %d", leaves, tree.Ended())
	}
}

// TestCgroupKillsEscapees stops a command whose child left the process group
// with setsid and ignores SIGTERM: cgroup.kill reaches it at the deadline.
// It needs root and a writable cgroup2, as in a guest.
func TestCgroupKillsEscapees(t *testing.T) {
	tree, err := cgroup.NewTree("/sys/fs/cgroup/imp-exec-test")
	if os.Geteuid() != 0 || err != nil {
		t.Skip("needs root and a writable cgroup2")
	}
	t.Cleanup(func() { os.Remove("/sys/fs/cgroup/imp-exec-test") })
	pidFile := filepath.Join(t.TempDir(), "pid")
	child := fmt.Sprintf(`trap "" TERM; echo $$ > %s; exec sleep 300`, pidFile)
	m := NewManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil), tree)
	h := startExec(t, m, proto.Request{
		Argv:        []string{"sh", "-c", fmt.Sprintf("setsid sh -c '%s' >/dev/null 2>&1 & exec sleep 300", child)},
		KillGraceMs: 300,
	})
	h.started(t)
	escapee := readPid(t, pidFile)
	killAfter(t, escapee)

	signal(t, h, syscall.SIGTERM)
	h.wait(t, 10*time.Second)
	if alive(escapee) {
		t.Fatalf("escapee %d survived the stop", escapee)
	}
}

// TestCgroupKillFallsBackToGroup: a leaf whose cgroup.kill cannot be
// written (here a plain directory) still gets its process group killed.
func TestCgroupKillFallsBackToGroup(t *testing.T) {
	tree, err := cgroup.NewTree(filepath.Join(t.TempDir(), "imp-exec"))
	if err != nil {
		t.Fatal(err)
	}
	g, err := tree.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tree.Release(g) })
	events := filepath.Join(g.Dir().Name(), "cgroup.events")
	if err := os.WriteFile(events, []byte("populated 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(events) })

	pid, err := syscall.ForkExec("/bin/sh", []string{"sh", "-c", `trap "" TERM; exec sleep 300`},
		&syscall.ProcAttr{Sys: &syscall.SysProcAttr{Setpgid: true}})
	if err != nil {
		t.Fatal(err)
	}
	killAfter(t, pid)

	killCgroup(g, proc.NewProcess(pid, nil, func(pid int, sig syscall.Signal, group bool) error {
		if group {
			pid = -pid
		}
		return syscall.Kill(pid, sig)
	}), time.Now())
	if alive(pid) {
		t.Fatalf("pid %d survived a failed cgroup.kill", pid)
	}
}
