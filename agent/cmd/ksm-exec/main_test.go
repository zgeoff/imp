package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// The test binary runs as the child when this is set: it prints its merge flag.
const childEnv = "KSM_EXEC_TEST_CHILD"

func TestMain(m *testing.M) {
	if os.Getenv(childEnv) == "1" {
		flag, err := unix.PrctlRetInt(unix.PR_GET_MEMORY_MERGE, 0, 0, 0, 0)
		if err != nil {
			os.Stdout.WriteString("error " + err.Error())
			os.Exit(1)
		}
		os.Stdout.WriteString(strconv.Itoa(flag))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// kernelAtLeast reports whether the running kernel is major.minor or later.
func kernelAtLeast(t *testing.T, major, minor int) bool {
	t.Helper()

	var uts unix.Utsname
	if err := unix.Uname(&uts); err != nil {
		t.Fatal(err)
	}

	release := unix.ByteSliceToString(uts.Release[:])
	parts := strings.SplitN(release, ".", 3)
	gotMajor, _ := strconv.Atoi(parts[0])
	gotMinor := 0
	if len(parts) > 1 {
		gotMinor, _ = strconv.Atoi(strings.TrimFunc(parts[1], func(r rune) bool { return r < '0' || r > '9' }))
	}

	return gotMajor > major || (gotMajor == major && gotMinor >= minor)
}

func TestTheExecedProgramKeepsTheMergeFlag(t *testing.T) {
	if !kernelAtLeast(t, 6, 7) {
		t.Skip("the merge flag survives exec from Linux 6.7")
	}
	if _, err := os.Stat("/sys/kernel/mm/ksm"); err != nil {
		t.Skip("this kernel has no KSM")
	}

	bin := filepath.Join(t.TempDir(), "ksm-exec")
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	child := exec.Command(bin, self)
	child.Env = append(os.Environ(), childEnv+"=1")
	out, err := child.Output()
	if err != nil {
		t.Fatalf("ksm-exec: %v (%s)", err, out)
	}
	if string(out) != "1" {
		t.Fatalf("the child's PR_GET_MEMORY_MERGE = %q, want 1", out)
	}
}

func TestAMissingProgramFails(t *testing.T) {
	if _, err := os.Stat("/sys/kernel/mm/ksm"); err != nil {
		t.Skip("this kernel has no KSM")
	}

	err := runMerged([]string{"/nonexistent/program"})
	if err == nil {
		t.Fatal("runMerged returned no error for a missing program")
	}
}
