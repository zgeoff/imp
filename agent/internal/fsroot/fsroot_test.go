package fsroot

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// setup makes a root dir and an "outside" dir next to it, which no path in
// the root may reach.
func setup(t *testing.T) (*Root, string, string) {
	t.Helper()
	base := t.TempDir()
	inside, outside := filepath.Join(base, "root"), filepath.Join(base, "outside")
	for _, d := range []string{inside + "/etc", outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("agent's"), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := Open(inside)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return r, inside, outside
}

func TestAnAbsoluteSymlinkResolvesInsideTheRoot(t *testing.T) {
	r, inside, outside := setup(t)
	// the user plants /etc/hosts -> <the agent's path>
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(inside, "etc/hosts")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadFile("/etc/hosts"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("read through the symlink: err = %v, want not exist", err)
	}
	if err := WriteFileAtomic(r, "/etc/hosts", []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "secret")); string(b) != "agent's" {
		t.Fatalf("the agent's file changed to %q", b)
	}
}

func TestDotDotStopsAtTheRoot(t *testing.T) {
	r, inside, _ := setup(t)
	if err := os.Symlink("../../outside", filepath.Join(inside, "etc/up")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadFile("/etc/up/secret"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("err = %v, want not exist", err)
	}
	if _, err := r.ReadFile("/../outside/secret"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("err = %v, want not exist", err)
	}
}

func TestFileOperationsInsideTheRoot(t *testing.T) {
	r, inside, _ := setup(t)
	if err := r.MkdirAll("/var/log/imp", 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := r.OpenFile("/var/log/imp/a.log", os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("hello\n")
	f.Close()
	if err := r.Rename("/var/log/imp/a.log", "/var/log/imp/a.log.1"); err != nil {
		t.Fatal(err)
	}
	fi, err := r.Stat("/var/log/imp/a.log.1")
	if err != nil || fi.Size() != 6 || fi.IsDir() {
		t.Fatalf("stat = %v, %v", fi, err)
	}
	ents, err := r.ReadDir("/var/log/imp")
	if err != nil || len(ents) != 1 || ents[0].Name() != "a.log.1" {
		t.Fatalf("readdir = %v, %v", ents, err)
	}
	if err := r.Truncate("/var/log/imp/a.log.1", 0); err != nil {
		t.Fatal(err)
	}
	if err := r.RemoveAll("/var/log"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(inside, "var/log")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("var/log still there: %v", err)
	}
}

func TestLstatSeesTheLinkItself(t *testing.T) {
	r, inside, _ := setup(t)
	if err := os.Symlink("/run/systemd/resolve/stub-resolv.conf", filepath.Join(inside, "etc/resolv.conf")); err != nil {
		t.Fatal(err)
	}
	fi, err := r.Lstat("/etc/resolv.conf")
	if err != nil || fi.Mode()&fs.ModeSymlink == 0 {
		t.Fatalf("lstat = %v, %v; want a symlink", fi, err)
	}
	if err := r.Remove("/etc/resolv.conf"); err != nil {
		t.Fatal(err)
	}
}

func TestStatSysIsASyscallStatT(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	fi, err := r.Stat("/f")
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.Stat(filepath.Join(dir, "f"))
	if err != nil {
		t.Fatal(err)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Ino != want.Sys().(*syscall.Stat_t).Ino {
		t.Fatalf("Sys() = %#v", fi.Sys())
	}
}
