package outer

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/proc"
)

// helperEnv makes the test binary run RunHelper on its arguments.
const helperEnv = "IMP_TEST_OUTER_HELPER"

func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) == "1" {
		// stand in for the agent's shield: any score above 0 shows the reset
		if err := os.WriteFile("/proc/self/oom_score_adj", []byte("500"), 0); err != nil {
			os.Exit(3)
		}
		err := RunHelper(os.Args[1:])
		os.Stderr.WriteString(err.Error())
		os.Exit(127)
	}
	os.Exit(m.Run())
}

// recorder is the agent's runner, keeping each spec it is asked to start.
type recorder struct{ specs []proc.Spec }

func (r *recorder) Start(s proc.Spec) (*proc.Process, error) {
	r.specs = append(r.specs, s)
	return &proc.Process{}, nil
}

// openCgroup stands in for a cgroup leaf with a directory the test owns.
func openCgroup(t *testing.T) *os.File {
	t.Helper()
	cg, err := os.Open(t.TempDir())
	assert.NilError(t, err)
	t.Cleanup(func() { cg.Close() })
	return cg
}

func TestRunnerStartsTheCommandThroughTheHelperInItsCgroup(t *testing.T) {
	cg := openCgroup(t)
	next := &recorder{}

	_, err := Runner{Next: next}.Start(proc.Spec{Argv: []string{"sh", "-c", "true"}, Env: []string{"PATH=/bin"}, Cgroup: cg})

	assert.NilError(t, err)
	assert.Assert(t, cmp.Len(next.specs, 1))
	got := next.specs[0]
	assert.Check(t, cmp.DeepEqual(got.Argv, []string{"imp-agent", Command, "/bin/sh", "sh", "-c", "true"}))
	assert.Check(t, got.Helper, "the spec does not start the helper")
	assert.Check(t, got.RequireCgroup, "the spec does not require its cgroup")
	assert.Check(t, got.Cgroup == cg, "the spec lost its cgroup")
}

// The refusals' messages are contract: the agent answers EXEC_FAILED with
// them.
func TestRunnerRefusesASpecWithoutACgroup(t *testing.T) {
	next := &recorder{}

	_, err := Runner{Next: next}.Start(proc.Spec{Argv: []string{"sh"}, Env: []string{"PATH=/bin"}})

	assert.Check(t, cmp.Error(err, "an outer exec needs its cgroup"))
	assert.Check(t, cmp.Len(next.specs, 0), "a spec reached the runner")
}

func TestRunnerRefusesAnEmptyArgv(t *testing.T) {
	next := &recorder{}

	_, err := Runner{Next: next}.Start(proc.Spec{Env: []string{"PATH=/bin"}, Cgroup: openCgroup(t)})

	assert.Check(t, cmp.Error(err, "empty argv"))
	assert.Check(t, cmp.Len(next.specs, 0), "a spec reached the runner")
}

func TestRunnerRefusesACommandThatIsNotOnPATH(t *testing.T) {
	next := &recorder{}

	_, err := Runner{Next: next}.Start(proc.Spec{Argv: []string{"no-such-command"}, Env: []string{"PATH=/bin"}, Cgroup: openCgroup(t)})

	assert.Check(t, cmp.Error(err, "no-such-command: executable file not found in $PATH"))
	assert.Check(t, cmp.Len(next.specs, 0), "a spec reached the runner")
}

// TestHelperResetsOOMScore: the command, and what it starts, can meet the
// OOM killer.
func TestHelperResetsOOMScore(t *testing.T) {
	cmd := exec.Command(os.Args[0], "/bin/sh", "sh", "-c", "cat /proc/self/oom_score_adj; true")
	cmd.Env = append(os.Environ(), helperEnv+"=1")

	out, err := cmd.CombinedOutput()

	assert.NilError(t, err, "helper output: %s", out)
	assert.Equal(t, strings.TrimSpace(string(out)), "0", "the command's child has the wrong oom_score_adj")
}

func TestHelperFailsOnABadPath(t *testing.T) {
	cmd := exec.Command(os.Args[0], filepath.Join(t.TempDir(), "missing"), "missing")
	cmd.Env = append(os.Environ(), helperEnv+"=1")

	err := cmd.Run()

	var exit *exec.ExitError
	assert.Assert(t, errors.As(err, &exit), "err = %v, want an exit", err)
	assert.Equal(t, exit.ExitCode(), 127)
}

func TestHelperRefusesTooFewArguments(t *testing.T) {
	err := RunHelper([]string{"/bin/sh"})

	// the usage line is what a person running the helper by hand sees
	assert.Error(t, err, "usage: imp-agent outer <path> <argv...>")
}
