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
	if os.Geteuid() != 0 {
		t.Skip("mknod needs root")
	}
	src, dst := t.TempDir(), t.TempDir()
	assert.NilError(t, unix.Mknod(filepath.Join(src, "null"), unix.S_IFCHR|0o666, int(unix.Mkdev(1, 3))))
	assert.NilError(t, os.Mkdir(filepath.Join(src, "net"), 0o755))
	assert.NilError(t, unix.Mknod(filepath.Join(src, "net", "tun"), unix.S_IFCHR|0o666, int(unix.Mkdev(10, 200))))
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
