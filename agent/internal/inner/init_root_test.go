//go:build root

// The tests that make device nodes, so they need root: run them with -tags root as root.

package inner

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestCopyDevKeepsNodesLinksAndModes(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	assert.NilError(t, unix.Mknod(filepath.Join(src, "null"), unix.S_IFCHR|0o666, int(unix.Mkdev(1, 3))))
	assert.NilError(t, os.Mkdir(filepath.Join(src, "net"), 0o755))
	assert.NilError(t, unix.Mknod(filepath.Join(src, "net", "tun"), unix.S_IFCHR|0o666, int(unix.Mkdev(10, 200))))
	// mknod applied the umask; the source keeps the modes a real /dev has
	assert.NilError(t, os.Chmod(filepath.Join(src, "null"), 0o666))
	assert.NilError(t, os.Chmod(filepath.Join(src, "net", "tun"), 0o666))
	assert.NilError(t, os.Symlink("/proc/self/fd", filepath.Join(src, "fd")))

	err := copyDev(src, dst)

	assert.NilError(t, err)
	modes := map[string]uint32{}
	for _, name := range []string{"null", "net/tun"} {
		var st unix.Stat_t
		assert.NilError(t, unix.Stat(filepath.Join(dst, name), &st))
		modes[name] = st.Mode & (unix.S_IFMT | 0o777)
	}
	assert.Check(t, cmp.DeepEqual(modes, map[string]uint32{
		"null":    unix.S_IFCHR | 0o666,
		"net/tun": unix.S_IFCHR | 0o666,
	}))
	link, err := os.Readlink(filepath.Join(dst, "fd"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(link, "/proc/self/fd"))
}

func TestBindReadOnlyRefusesRootsWritesAndShowsTheSourcesOwn(t *testing.T) {
	src, target := t.TempDir(), filepath.Join(t.TempDir(), "run/imp/files")
	assert.NilError(t, os.WriteFile(filepath.Join(src, "record.json"), []byte(`{"revision":1}`), 0o444))

	err := bindReadOnly(src, target)

	assert.NilError(t, err)
	t.Cleanup(func() { unix.Unmount(target, unix.MNT_DETACH) })
	assert.Check(t, cmp.ErrorIs(os.WriteFile(filepath.Join(target, "record.json"), []byte("{}"), 0o644), unix.EROFS))
	assert.Check(t, cmp.ErrorIs(os.WriteFile(filepath.Join(target, "other.json"), []byte("{}"), 0o644), unix.EROFS))
	assert.Check(t, cmp.ErrorIs(os.Remove(filepath.Join(target, "record.json")), unix.EROFS))
	assert.Check(t, cmp.ErrorIs(os.Chmod(filepath.Join(target, "record.json"), 0o644), unix.EROFS))
	assert.NilError(t, os.WriteFile(filepath.Join(src, ".staged"), []byte(`{"revision":2}`), 0o444))
	assert.NilError(t, os.Rename(filepath.Join(src, ".staged"), filepath.Join(src, "record.json")))
	b, err := os.ReadFile(filepath.Join(target, "record.json"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), `{"revision":2}`))
}
