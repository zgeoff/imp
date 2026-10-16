//go:build root

// The tests of an exec that drops CAP_SYS_ADMIN, which mount and change
// users, so they need root: run them with -tags root as root.

package proc

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/dropcaps"
)

// The test binary stands in for the agent binary: started as the helper, it
// runs the helper's body, as imp-agent's main does.
func init() {
	if len(os.Args) > 1 && os.Args[1] == dropcaps.Command {
		err := dropcaps.RunHelper(os.Args[2:])
		fmt.Fprintf(os.Stderr, "helper: %v\n", err)
		os.Exit(127)
	}
}

// setupReadOnlyBind mounts a tmpfs and binds it read-only, as the inner init
// binds the read-only files, and returns the bind.
func setupReadOnlyBind(t *testing.T) string {
	t.Helper()
	src, target := t.TempDir(), t.TempDir()
	assert.NilError(t, unix.Mount("tmpfs", src, "tmpfs", 0, "size=1m"))
	t.Cleanup(func() { unix.Unmount(src, unix.MNT_DETACH) })
	assert.NilError(t, os.WriteFile(filepath.Join(src, "record.json"), []byte(`{"revision":1}`), 0o444))
	assert.NilError(t, unix.Mount(src, target, "", unix.MS_BIND, ""))
	t.Cleanup(func() { unix.Unmount(target, unix.MNT_DETACH) })
	assert.NilError(t, unix.Mount("", target, "", unix.MS_REMOUNT|unix.MS_BIND|unix.MS_RDONLY, ""))
	return target
}

// parseCapSet reads one capability set of /proc/self/status, as `grep` in
// the child printed it.
func parseCapSet(t *testing.T, out, name string) uint64 {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		if hex, ok := strings.CutPrefix(line, name+":"); ok {
			n, err := strconv.ParseUint(strings.TrimSpace(hex), 16, 64)
			assert.NilError(t, err)
			return n
		}
	}
	t.Fatalf("no %s in %q", name, out)
	return 0
}

func TestDropSysAdminRefusesRootARemountOfTheReadOnlyFiles(t *testing.T) {
	d := &Direct{Reaper: testReaper, Agent: os.Args[0]}
	target := setupReadOnlyBind(t)

	got := run(t, d, Spec{
		Argv:         []string{"sh", "-c", `mount -o remount,bind,rw "$0" 2>/dev/null && echo remounted || echo refused; touch "$0/forged.json" 2>/dev/null || echo read-only`, target},
		Env:          []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"},
		DropSysAdmin: true,
	})

	assert.Equal(t, got, "refused\nread-only")
}

func TestWithoutDropSysAdminRootRemountsTheReadOnlyFilesWritable(t *testing.T) {
	d := &Direct{Reaper: testReaper, Agent: os.Args[0]}
	target := setupReadOnlyBind(t)

	got := run(t, d, Spec{
		Argv: []string{"sh", "-c", `mount -o remount,bind,rw "$0" 2>/dev/null && echo remounted || echo refused; touch "$0/forged.json" && echo written`, target},
		Env:  []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"},
	})

	assert.Equal(t, got, "remounted\nwritten")
}

func TestDropSysAdminTakesBothCapabilitiesFromEverySetAndKeepsTheRest(t *testing.T) {
	d := &Direct{Reaper: testReaper, Agent: os.Args[0]}
	dropped := uint64(1)<<unix.CAP_SYS_ADMIN | uint64(1)<<unix.CAP_SYS_PTRACE

	got := run(t, d, Spec{
		Argv:         []string{"grep", "^Cap", "/proc/self/status"},
		Env:          []string{"PATH=/usr/bin:/bin"},
		DropSysAdmin: true,
	})

	held := map[string]uint64{}
	for _, set := range []string{"CapBnd", "CapPrm", "CapEff", "CapInh", "CapAmb"} {
		held[set] = parseCapSet(t, got, set) & dropped
	}
	assert.Check(t, cmp.DeepEqual(held, map[string]uint64{"CapBnd": 0, "CapPrm": 0, "CapEff": 0, "CapInh": 0, "CapAmb": 0}))
	assert.Check(t, parseCapSet(t, got, "CapEff")&(1<<unix.CAP_CHOWN) != 0, "root keeps CAP_CHOWN")
}

func TestDropSysAdminRunsTheCommandAsItsUserWithTheBoundingSetDropped(t *testing.T) {
	d := &Direct{Reaper: testReaper, Agent: os.Args[0]}
	dropped := uint64(1)<<unix.CAP_SYS_ADMIN | uint64(1)<<unix.CAP_SYS_PTRACE

	got := run(t, d, Spec{
		Argv:         []string{"sh", "-c", `echo "$(id -u) $(id -g) $(id -G)"; grep ^CapBnd /proc/self/status`},
		Env:          []string{"PATH=/usr/bin:/bin"},
		Cred:         &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{65533}},
		DropSysAdmin: true,
	})

	ids, _, _ := strings.Cut(got, "\n")
	assert.Check(t, cmp.Equal(ids, "65534 65534 65534 65533"))
	assert.Check(t, cmp.Equal(parseCapSet(t, got, "CapBnd")&dropped, uint64(0)))
}

func TestDropSysAdminLeavesTheCommandNoFdOfTheAgentBinary(t *testing.T) {
	f, err := os.Open(os.Args[0])
	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })
	d := &Direct{Reaper: testReaper, Agent: os.Args[0], AgentFile: f}

	// the agent's fd follows the three stdio fds
	got := run(t, d, Spec{
		Argv:         []string{"sh", "-c", `test -e /proc/$$/fd/3 && echo held || echo closed`},
		Env:          []string{"PATH=/usr/bin:/bin"},
		DropSysAdmin: true,
	})

	assert.Equal(t, got, "closed")
}
