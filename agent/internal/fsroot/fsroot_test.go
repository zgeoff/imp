package fsroot

import (
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

// setup makes a root dir with an etc directory, and an "outside" dir next
// to it holding the agent's secret, which no path in the root may reach.
func setup(t *testing.T) (*Root, string, string) {
	t.Helper()
	base := t.TempDir()
	inside, outside := filepath.Join(base, "root"), filepath.Join(base, "outside")
	assert.NilError(t, os.MkdirAll(filepath.Join(inside, "etc"), 0o755))
	assert.NilError(t, os.MkdirAll(outside, 0o755))
	assert.NilError(t, os.WriteFile(filepath.Join(outside, "secret"), []byte("agent's"), 0o600))
	r, err := Open(inside)
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })
	return r, inside, outside
}

func TestSetupOpensARootBesideAnOutsideSecret(t *testing.T) {
	r, inside, outside := setup(t)

	fi, err := r.Stat("/etc")

	assert.NilError(t, err)
	assert.Check(t, fi.IsDir())
	assert.Check(t, cmp.Equal(filepath.Dir(inside), filepath.Dir(outside)))
	b, err := os.ReadFile(filepath.Join(outside, "secret"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "agent's"))
}

func TestReadFileResolvesAnAbsoluteSymlinkInsideTheRoot(t *testing.T) {
	r, inside, outside := setup(t)
	// the user plants /etc/hosts -> <the agent's path>
	assert.NilError(t, os.Symlink(filepath.Join(outside, "secret"), filepath.Join(inside, "etc/hosts")))

	_, err := r.ReadFile("/etc/hosts")

	assert.ErrorIs(t, err, fs.ErrNotExist)
}

func TestWriteFileAtomicNeverWritesThroughAPlantedSymlinkToOutside(t *testing.T) {
	r, inside, outside := setup(t)
	assert.NilError(t, os.Symlink(filepath.Join(outside, "secret"), filepath.Join(inside, "etc/hosts")))

	err := WriteFileAtomic(r, "/etc/hosts", []byte("x"), 0o644)

	assert.NilError(t, err)
	b, err := os.ReadFile(filepath.Join(outside, "secret"))
	assert.NilError(t, err)
	assert.Equal(t, string(b), "agent's", "the agent's file changed")
}

func TestReadFileStopsDotDotAtTheRoot(t *testing.T) {
	for _, tc := range []struct {
		name string
		path string
		link string // a relative link planted at /etc/up, or ""
	}{
		{name: "through a relative link", path: "/etc/up/secret", link: "../../outside"},
		{name: "in the path itself", path: "/../outside/secret"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, inside, _ := setup(t)
			if tc.link != "" {
				assert.NilError(t, os.Symlink(tc.link, filepath.Join(inside, "etc/up")))
			}

			_, err := r.ReadFile(tc.path)

			assert.ErrorIs(t, err, fs.ErrNotExist)
		})
	}
}

func TestMkdirAllAndOpenFileCreateAFileInsideTheRoot(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, r.MkdirAll("/var/log/imp", 0o755))

	f, err := r.OpenFile("/var/log/imp/a.log", os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)

	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })
	_, err = f.WriteString("hello\n")
	assert.NilError(t, err)
	b, err := os.ReadFile(filepath.Join(inside, "var/log/imp/a.log"))
	assert.NilError(t, err)
	assert.Equal(t, string(b), "hello\n")
}

func TestMkdirAllRefusesAPathThroughAFile(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.WriteFile(filepath.Join(inside, "etc/file"), nil, 0o644))

	err := r.MkdirAll("/etc/file/sub", 0o755)

	assert.ErrorIs(t, err, unix.ENOTDIR)
}

func TestRenameMovesAFileInsideTheRoot(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.WriteFile(filepath.Join(inside, "etc/a.log"), []byte("hello\n"), 0o644))

	err := r.Rename("/etc/a.log", "/etc/a.log.1")

	assert.NilError(t, err)
	_, err = os.Stat(filepath.Join(inside, "etc/a.log"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
	b, err := os.ReadFile(filepath.Join(inside, "etc/a.log.1"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "hello\n"))
}

func TestStatReportsTheNameSizeAndKind(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.WriteFile(filepath.Join(inside, "etc/a.log"), []byte("hello\n"), 0o644))
	// whatever the umask left
	assert.NilError(t, os.Chmod(filepath.Join(inside, "etc/a.log"), 0o644))

	fi, err := r.Stat("/etc/a.log")

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(fi.Name(), "a.log"))
	assert.Check(t, cmp.Equal(fi.Size(), int64(6)))
	assert.Check(t, cmp.Equal(fi.Mode(), fs.FileMode(0o644)))
}

func TestReadDirListsTheEntries(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.WriteFile(filepath.Join(inside, "etc/a.log.1"), nil, 0o644))

	ents, err := r.ReadDir("/etc")

	assert.NilError(t, err)
	names := []string{}
	for _, e := range ents {
		names = append(names, e.Name())
	}
	assert.DeepEqual(t, names, []string{"a.log.1"})
}

func TestTruncateCutsAFileToTheSize(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.WriteFile(filepath.Join(inside, "etc/a.log"), []byte("hello\n"), 0o644))

	err := r.Truncate("/etc/a.log", 2)

	assert.NilError(t, err)
	b, err := os.ReadFile(filepath.Join(inside, "etc/a.log"))
	assert.NilError(t, err)
	assert.Equal(t, string(b), "he")
}

func TestRemoveAllRemovesATreeInsideTheRoot(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.MkdirAll(filepath.Join(inside, "var/log/imp"), 0o755))
	assert.NilError(t, os.WriteFile(filepath.Join(inside, "var/log/imp/a.log"), []byte("hello\n"), 0o644))

	err := r.RemoveAll("/var/log")

	assert.NilError(t, err)
	_, err = os.Stat(filepath.Join(inside, "var/log"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
	_, err = os.Stat(filepath.Join(inside, "var"))
	assert.Check(t, err, "RemoveAll went above the path it was given")
}

func TestRemoveRefusesTheRootItself(t *testing.T) {
	r, _, _ := setup(t)

	err := r.Remove("/")

	assert.ErrorContains(t, err, "the root has no parent")
}

func TestChmodSetsTheModeInsideTheRoot(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.WriteFile(filepath.Join(inside, "etc/a"), nil, 0o644))

	err := r.Chmod("/etc/a", 0o600)

	assert.NilError(t, err)
	fi, err := os.Stat(filepath.Join(inside, "etc/a"))
	assert.NilError(t, err)
	assert.Equal(t, fi.Mode().Perm(), fs.FileMode(0o600))
}

func TestLstatSeesTheLinkItself(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.Symlink("/run/systemd/resolve/stub-resolv.conf", filepath.Join(inside, "etc/resolv.conf")))

	fi, err := r.Lstat("/etc/resolv.conf")

	assert.NilError(t, err)
	assert.Check(t, fi.Mode()&fs.ModeSymlink != 0, "mode %v, want a symlink", fi.Mode())
}

func TestRemoveRemovesALinkWhoseTargetIsMissing(t *testing.T) {
	r, inside, _ := setup(t)
	assert.NilError(t, os.Symlink("/run/systemd/resolve/stub-resolv.conf", filepath.Join(inside, "etc/resolv.conf")))

	err := r.Remove("/etc/resolv.conf")

	assert.NilError(t, err)
	_, err = os.Lstat(filepath.Join(inside, "etc/resolv.conf"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
}

func TestStatSysIsASyscallStatTOfTheFile(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.WriteFile(filepath.Join(dir, "f"), nil, 0o644))
	r, err := Open(dir)
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })
	want, err := os.Stat(filepath.Join(dir, "f"))
	assert.NilError(t, err)

	fi, err := r.Stat("/f")

	assert.NilError(t, err)
	st, ok := fi.Sys().(*syscall.Stat_t)
	assert.Assert(t, ok, "Sys() = %#v", fi.Sys())
	assert.Equal(t, st.Ino, want.Sys().(*syscall.Stat_t).Ino)
}

func TestReadFileRefusesAFIFOWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, unix.Mkfifo(filepath.Join(dir, "fifo"), 0o644))
	r, err := Open(dir)
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })

	_, err = r.ReadFile("/fifo")

	assert.ErrorIs(t, err, ErrNotRegular)
}

// A root with a real /proc: /proc/self/root is a magic link, which could
// lead out of any root.
func TestReadFileRefusesAMagicLink(t *testing.T) {
	r, err := Open("/")
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })

	_, err = r.ReadFile("/proc/self/root/proc/self/status")

	assert.ErrorIs(t, err, unix.ELOOP)
}

func TestReadFileReadsAPlainProcFile(t *testing.T) {
	r, err := Open("/")
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })

	_, err = r.ReadFile("/proc/self/status")

	assert.NilError(t, err)
}
