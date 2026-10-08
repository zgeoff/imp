package proc

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/imp/agent/internal/reaper"
)

// The reap loop is process-wide, so the package shares one Reaper.
var testReaper = reaper.New()

// devNull opens /dev/null for the rest of the test.
func devNull(t *testing.T) *os.File {
	t.Helper()
	f, err := os.Open(os.DevNull)
	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })
	return f
}

// run starts spec, waits for it to exit, and returns what it wrote to
// stdout and stderr.
func run(t *testing.T, d *Direct, spec Spec) string {
	t.Helper()
	r, w, err := os.Pipe()
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })
	spec.Files = []*os.File{devNull(t), w, w}
	p, err := d.Start(spec)
	w.Close()
	assert.NilError(t, err)
	out, err := io.ReadAll(r)
	assert.NilError(t, err)
	<-p.Done
	return strings.TrimSpace(string(out))
}

// startGroup starts sh leaving a sleep in its process group, and returns
// once the sleep has started. Cleanup kills whatever is left of the group.
func startGroup(t *testing.T, d *Direct) *Process {
	t.Helper()
	r, w, err := os.Pipe()
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })
	null := devNull(t)
	p, err := d.Start(Spec{
		Argv:  []string{"sh", "-c", "sleep 30 & echo ready; wait"},
		Env:   []string{"PATH=/usr/bin:/bin"},
		Files: []*os.File{null, w, null},
	})
	w.Close()
	assert.NilError(t, err)
	t.Cleanup(func() { p.Signal(syscall.SIGKILL) })
	line, err := bufio.NewReader(r).ReadString('\n')
	assert.NilError(t, err)
	assert.Equal(t, line, "ready\n")
	return p
}

// agentCopy copies /bin/echo to stand in for the agent binary, opens it, and
// removes its path, as an agent whose system drive went away.
func agentCopy(t *testing.T) (path string, f *os.File) {
	t.Helper()
	b, err := os.ReadFile("/bin/echo")
	if err != nil {
		t.Skip("no /bin/echo")
	}
	path = filepath.Join(t.TempDir(), "agent")
	assert.NilError(t, os.WriteFile(path, b, 0o755))
	f, err = os.Open(path)
	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })
	assert.NilError(t, os.Remove(path))
	return path, f
}

func TestStartRunsAnEmptyDirInTheWorkdir(t *testing.T) {
	d := &Direct{Reaper: testReaper}
	work := t.TempDir()

	got := run(t, d, Spec{Argv: []string{"pwd"}, Env: []string{"PATH=/usr/bin:/bin", "HOME=" + t.TempDir()}, Workdir: work})

	assert.Equal(t, got, work)
}

func TestStartRunsAnEmptyDirInHomeWhenTheWorkdirIsMissing(t *testing.T) {
	d := &Direct{Reaper: testReaper}
	home := t.TempDir()

	got := run(t, d, Spec{Argv: []string{"pwd"}, Env: []string{"PATH=/usr/bin:/bin", "HOME=" + home}, Workdir: filepath.Join(t.TempDir(), "missing")})

	assert.Equal(t, got, home)
}

func TestStartRunsAHelperFromTheAgentsOwnFd(t *testing.T) {
	bin, f := agentCopy(t)
	d := &Direct{Reaper: testReaper, Agent: bin, AgentFile: f}

	got := run(t, d, Spec{Argv: []string{"imp-agent", "hello"}, Helper: true})

	assert.Equal(t, got, "hello")
}

// impd's sftp runs the agent by its path.
func TestStartRunsTheAgentByItsPathFromItsOwnFd(t *testing.T) {
	bin, f := agentCopy(t)
	d := &Direct{Reaper: testReaper, Agent: bin, AgentFile: f}

	got := run(t, d, Spec{Argv: []string{bin, "by path"}})

	assert.Equal(t, got, "by path")
}

func TestStartRefusesAnEmptyArgv(t *testing.T) {
	d := &Direct{Reaper: testReaper}

	p, err := d.Start(Spec{Env: []string{"PATH=/usr/bin:/bin"}})

	assert.Check(t, cmp.ErrorContains(err, "empty argv"))
	assert.Check(t, cmp.Nil(p))
}

func TestKillReachesOnlyTheChildWhileGroupAliveSeesTheRest(t *testing.T) {
	d := &Direct{Reaper: testReaper}
	p := startGroup(t, d)

	assert.NilError(t, p.Kill())

	st := <-p.Done
	assert.Check(t, cmp.Equal(st.Signal, syscall.SIGKILL))
	assert.Check(t, p.GroupAlive(), "the group should still have its sleep")
}

func TestKillAfterTheReapFailsWithESRCH(t *testing.T) {
	d := &Direct{Reaper: testReaper}
	p, err := d.Start(Spec{Argv: []string{"true"}, Env: []string{"PATH=/usr/bin:/bin"}})
	assert.NilError(t, err)
	<-p.Done

	err = p.Kill()

	assert.ErrorIs(t, err, syscall.ESRCH)
}

func TestGroupAliveTurnsFalseOnceTheGroupIsGone(t *testing.T) {
	d := &Direct{Reaper: testReaper}
	p := startGroup(t, d)

	assert.NilError(t, p.Signal(syscall.SIGKILL))

	<-p.Done
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if p.GroupAlive() {
			return poll.Continue("the group is still alive")
		}
		return poll.Success()
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))
}

// openPlainDir opens a directory that is not a cgroup, as a Spec.Cgroup.
func openPlainDir(t *testing.T) *os.File {
	t.Helper()
	dir, err := os.Open(t.TempDir())
	assert.NilError(t, err)
	t.Cleanup(func() { dir.Close() })
	return dir
}

func TestStartFallsBackToNoCgroupWhenTheLeafIsNotOne(t *testing.T) {
	d := &Direct{Reaper: testReaper}

	p, err := d.Start(Spec{Argv: []string{"true"}, Env: []string{"PATH=/usr/bin:/bin"}, Cgroup: openPlainDir(t)})

	assert.NilError(t, err)
	<-p.Done
	assert.Check(t, !p.InCgroup, "InCgroup for a plain directory")
}

func TestStartRefusesARequiredCgroupThatIsNotOne(t *testing.T) {
	d := &Direct{Reaper: testReaper}

	p, err := d.Start(Spec{Argv: []string{"true"}, Env: []string{"PATH=/usr/bin:/bin"}, Cgroup: openPlainDir(t), RequireCgroup: true})

	assert.Check(t, err != nil, "a required cgroup that is not one did not fail the spawn")
	assert.Check(t, cmp.Nil(p))
}
