package inner

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestCopyDevKeepsNodesLinksAndModes(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("mknod needs root")
	}
	src, dst := t.TempDir(), t.TempDir()
	if err := unix.Mknod(filepath.Join(src, "null"), unix.S_IFCHR|0o666, int(unix.Mkdev(1, 3))); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(src, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mknod(filepath.Join(src, "net", "tun"), unix.S_IFCHR|0o666, int(unix.Mkdev(10, 200))); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/proc/self/fd", filepath.Join(src, "fd")); err != nil {
		t.Fatal(err)
	}
	if err := copyDev(src, dst); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"null", "net/tun"} {
		var st unix.Stat_t
		if err := unix.Stat(filepath.Join(dst, name), &st); err != nil {
			t.Fatal(err)
		}
		if st.Mode&unix.S_IFMT != unix.S_IFCHR || st.Mode&0o777 != 0o666 {
			t.Fatalf("%s: mode %o", name, st.Mode)
		}
	}
	if link, err := os.Readlink(filepath.Join(dst, "fd")); err != nil || link != "/proc/self/fd" {
		t.Fatalf("fd -> %q, %v", link, err)
	}
}
