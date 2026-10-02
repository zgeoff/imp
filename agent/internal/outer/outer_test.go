package outer

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

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

type recorder struct{ specs []proc.Spec }

func (r *recorder) Start(s proc.Spec) (*proc.Process, error) {
	r.specs = append(r.specs, s)
	return &proc.Process{}, nil
}

func TestRunnerStartsTheHelper(t *testing.T) {
	cg, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer cg.Close()
	next := &recorder{}
	r := Runner{Next: next}
	if _, err := r.Start(proc.Spec{Argv: []string{"sh", "-c", "true"}, Env: []string{"PATH=/bin"}, Cgroup: cg}); err != nil {
		t.Fatal(err)
	}
	got := next.specs[0]
	want := []string{"imp-agent", Command, "/bin/sh", "sh", "-c", "true"}
	if !slices.Equal(got.Argv, want) || !got.Helper || !got.RequireCgroup || got.Cgroup != cg {
		t.Fatalf("spec = %+v, want the helper %v in the required cgroup", got, want)
	}
}

func TestRunnerRefuses(t *testing.T) {
	cg, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer cg.Close()
	next := &recorder{}
	r := Runner{Next: next}
	if _, err := r.Start(proc.Spec{Argv: []string{"sh"}, Env: []string{"PATH=/bin"}}); err == nil {
		t.Fatal("started without a cgroup")
	}
	if _, err := r.Start(proc.Spec{Argv: []string{"no-such-command"}, Env: []string{"PATH=/bin"}, Cgroup: cg}); err == nil {
		t.Fatal("started a command that is not on PATH")
	}
	if len(next.specs) != 0 {
		t.Fatalf("specs reached the runner: %+v", next.specs)
	}
}

// TestHelperResetsOOMScore: the command, and what it starts, can meet the
// OOM killer.
func TestHelperResetsOOMScore(t *testing.T) {
	cmd := exec.Command(os.Args[0], "/bin/sh", "sh", "-c", "cat /proc/self/oom_score_adj; true")
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper: %v: %s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "0" {
		t.Fatalf("the command's child has oom_score_adj %q, want 0", got)
	}
}

func TestHelperFailsOnABadPath(t *testing.T) {
	cmd := exec.Command(os.Args[0], filepath.Join(t.TempDir(), "missing"), "missing")
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	err := cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 127 {
		t.Fatalf("err = %v, want exit 127", err)
	}
}
