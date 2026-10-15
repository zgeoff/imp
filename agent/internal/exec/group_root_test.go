//go:build root

// The tests that need root and a writable cgroup2, as in a guest: run them with -tags root as root.

package exec

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/impz/agent/internal/cgroup"
	"github.com/zgeoff/impz/agent/internal/imagecfg"
	"github.com/zgeoff/impz/agent/internal/launch"
	"github.com/zgeoff/impz/agent/internal/proc"
	"github.com/zgeoff/impz/agent/internal/proto"
)

// A stopped command's child that left the process group with setsid and
// ignores SIGTERM still dies: cgroup.kill reaches it at the deadline. It
// needs root and a writable cgroup2, as in a guest.
func TestKillGraceReachesAChildThatLeftTheProcessGroup(t *testing.T) {
	// cgroup2 fixes the mount; a fresh directory under it is this test's own.
	parent, err := os.MkdirTemp("/sys/fs/cgroup", "imp-exec-test-")
	if err != nil {
		t.Fatalf("needs a writable cgroup2: %v", err)
	}
	t.Cleanup(func() { removeCgroup(t, parent) })
	tree, err := cgroup.NewTree(parent)
	assert.NilError(t, err)
	pidFile := filepath.Join(t.TempDir(), "pid")
	child := fmt.Sprintf(`trap "" TERM; echo $$ > %s; exec sleep 300`, pidFile)
	m := NewManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil), tree)
	h := startExec(t, m, &proto.Request{
		Argv:        []string{"sh", "-c", fmt.Sprintf("setsid sh -c '%s' >/dev/null 2>&1 & exec sleep 300", child)},
		KillGraceMs: new(uint32(300)),
	})
	h.started(t)
	escapee := readPid(t, pidFile)
	killAfter(t, escapee)

	signal(t, h, syscall.SIGTERM)
	h.wait(t, 10*time.Second)

	assert.Check(t, !alive(escapee), "escapee %d survived the stop", escapee)
}

// removeCgroup kills whatever still runs in the cgroup dir this test made
// and removes it with every cgroup under it, deepest first. It is safe after
// a failure part way: what is already gone is skipped.
func removeCgroup(t *testing.T, dir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "cgroup.kill"), []byte("1"), 0o600); err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("cgroup.kill %s: %v", dir, err)
	}
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		b, err := os.ReadFile(filepath.Join(dir, "cgroup.events"))
		if errors.Is(err, fs.ErrNotExist) || err == nil && strings.Contains(string(b), "populated 0") {
			return poll.Success()
		}
		return poll.Continue("%s still holds processes", dir)
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))
	var dirs []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			dirs = append(dirs, path)
		}
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("walk %s: %v", dir, err)
	}
	// a cgroup goes with rmdir, children before their parent
	for _, d := range slices.Backward(dirs) {
		if err := syscall.Rmdir(d); err != nil && !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("remove cgroup %s: %v", d, err)
		}
	}
}
