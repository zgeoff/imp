package proc

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/reaper"
)

var testReaper = reaper.New()

// run starts spec and returns what it wrote to stdout.
func run(t *testing.T, d *Direct, spec Spec) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	spec.Files = []*os.File{nil, w, w}
	devnull, _ := os.Open(os.DevNull)
	defer devnull.Close()
	spec.Files[0] = devnull
	p, err := d.Start(spec)
	w.Close()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	out := make([]byte, 4096)
	n, _ := r.Read(out)
	<-p.Done
	return strings.TrimSpace(string(out[:n]))
}

func TestAnEmptyDirFallsBackToTheWorkdirThenHome(t *testing.T) {
	d := &Direct{Reaper: testReaper}
	work := t.TempDir()
	env := []string{"PATH=/usr/bin:/bin", "HOME=" + t.TempDir()}

	got := run(t, d, Spec{Argv: []string{"pwd"}, Env: env, Workdir: work})
	if got != work {
		t.Fatalf("pwd = %q, want the workdir %q", got, work)
	}
	got = run(t, d, Spec{Argv: []string{"pwd"}, Env: env, Workdir: filepath.Join(work, "missing")})
	if got != strings.TrimPrefix(env[1], "HOME=") {
		t.Fatalf("pwd = %q, want HOME", got)
	}
}

func TestAHelperRunsTheAgentFromItsOwnFd(t *testing.T) {
	// "the agent" is /bin/echo here; its path goes away after the fd opens
	dir := t.TempDir()
	bin := filepath.Join(dir, "agent")
	b, err := os.ReadFile("/bin/echo")
	if err != nil {
		t.Skip("no /bin/echo")
	}
	if err := os.WriteFile(bin, b, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(bin)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	os.Remove(bin)

	d := &Direct{Reaper: testReaper, Agent: bin, AgentFile: f}
	if got := run(t, d, Spec{Argv: []string{"imp-agent", "hello"}, Helper: true}); got != "hello" {
		t.Fatalf("helper said %q", got)
	}
	// an exec of the agent by its path, as impd's sftp
	if got := run(t, d, Spec{Argv: []string{bin, "by path"}}); got != "by path" {
		t.Fatalf("the agent by its path said %q", got)
	}
}

func TestKillReachesOnlyTheChildAndGroupAliveSeesTheGroup(t *testing.T) {
	d := &Direct{Reaper: testReaper}
	devnull, _ := os.Open(os.DevNull)
	defer devnull.Close()
	// the child leaves a grandchild in its group, then waits
	p, err := d.Start(Spec{
		Argv:  []string{"sh", "-c", "sleep 30 & wait"},
		Env:   []string{"PATH=/usr/bin:/bin"},
		Files: []*os.File{devnull, devnull, devnull},
	})
	if err != nil {
		t.Fatal(err)
	}
	// let the sh start its sleep
	time.Sleep(200 * time.Millisecond)
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	st := <-p.Done
	if st.Signal != syscall.SIGKILL {
		t.Fatalf("status = %+v, want SIGKILL", st)
	}
	// the sleep is still in the group
	if !p.GroupAlive() {
		t.Fatal("the group should still have its sleep")
	}
	if err := p.Kill(); err != syscall.ESRCH {
		t.Fatalf("a kill after the reap = %v, want ESRCH", err)
	}
	p.Signal(syscall.SIGKILL)
	deadline := time.Now().Add(5 * time.Second)
	for p.GroupAlive() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if p.GroupAlive() {
		t.Fatal("the group outlived its SIGKILL")
	}
}
