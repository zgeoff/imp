package services

import (
	"os"
	"path/filepath"
	"testing"
)

func writeLog(t *testing.T, path string, size int64, head string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(head), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, size); err != nil {
		t.Fatal(err)
	}
}

func size(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size()
}

func TestRotateLog(t *testing.T) {
	dir := t.TempDir()
	small, big := filepath.Join(dir, "small.log"), filepath.Join(dir, "big.log")
	writeLog(t, small, maxLogSize, "s")
	writeLog(t, big, maxLogSize+1, "b")
	writeLog(t, big+".1", 1, "old")

	for _, p := range []string{small, big, filepath.Join(dir, "missing.log")} {
		if err := rotateLog(p); err != nil {
			t.Fatal(err)
		}
	}
	if size(t, small) != maxLogSize {
		t.Fatal("a log at the cap was rotated")
	}
	if _, err := os.Stat(big); !os.IsNotExist(err) {
		t.Fatalf("big log still in place: %v", err)
	}
	if size(t, big+".1") != maxLogSize+1 {
		t.Fatal("big log did not replace .1")
	}
}

// TestCopyTruncateLog checks that a writer holding the log O_APPEND keeps
// writing to it after the copy, starting at the new end.
func TestCopyTruncateLog(t *testing.T) {
	p := filepath.Join(t.TempDir(), "svc.log")
	writeLog(t, p, maxLogSize+1, "first")
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	if err := copyTruncateLog(p); err != nil {
		t.Fatal(err)
	}
	if size(t, p+".1") != maxLogSize+1 {
		t.Fatal(".1 is not a full copy")
	}
	if _, err := f.WriteString("after\n"); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(p); err != nil || string(b) != "after\n" {
		t.Fatalf("log = %q, %v; want only the new line", b, err)
	}
	if _, err := os.Stat(p + ".1.tmp"); !os.IsNotExist(err) {
		t.Fatal("temporary copy left behind")
	}
}
