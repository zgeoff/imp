package disk

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// fakeDisk stands in for the device size file and the resize ioctl.
type fakeDisk struct {
	sizePath string
	resized  []uint64
}

func installFakeDisk(t *testing.T, sectors int64) *fakeDisk {
	f := &fakeDisk{sizePath: filepath.Join(t.TempDir(), "size")}
	f.setSectors(t, sectors)
	prevPath, prevResize, prevBlock := SizePath, resizeFS, blockSize
	SizePath = f.sizePath
	resizeFS = func(_ string, blocks uint64) error {
		f.resized = append(f.resized, blocks)
		return nil
	}
	blockSize = func(string) (int64, error) { return 4096, nil }
	t.Cleanup(func() { SizePath, resizeFS, blockSize = prevPath, prevResize, prevBlock })
	return f
}

// setSectors replaces the file in one rename: a sysfs read never sees a
// half-written value, and the poll must not either.
func (f *fakeDisk) setSectors(t *testing.T, sectors int64) {
	tmp := f.sizePath + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(sectors, 10)+"\n"), 0o644); err != nil {
		t.Error(err)
		return
	}
	if err := os.Rename(tmp, f.sizePath); err != nil {
		t.Error(err)
	}
}

func TestGrowFillsTheDevice(t *testing.T) {
	f := installFakeDisk(t, 8<<21) // 8 GiB
	if err := Grow("/"); err != nil {
		t.Fatal(err)
	}
	if len(f.resized) != 1 || f.resized[0] != 8<<30/4096 {
		t.Fatalf("resized = %v, want [%d]", f.resized, 8<<30/4096)
	}
}

func TestWaitAndGrowWaitsForTheNewSize(t *testing.T) {
	f := installFakeDisk(t, 4<<21)
	go func() {
		time.Sleep(60 * time.Millisecond)
		f.setSectors(t, 6<<21)
	}()
	if err := WaitAndGrow("/", 6<<30, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if len(f.resized) != 1 || f.resized[0] != 6<<30/4096 {
		t.Fatalf("resized = %v, want [%d]", f.resized, 6<<30/4096)
	}
}

func TestWaitAndGrowGivesUpWithoutResizing(t *testing.T) {
	f := installFakeDisk(t, 4<<21)
	if err := WaitAndGrow("/", 6<<30, 50*time.Millisecond); err == nil {
		t.Fatal("want an error when the device never grows")
	}
	if len(f.resized) != 0 {
		t.Fatalf("resized = %v, want none", f.resized)
	}
}

func TestGrowReportsTheIoctlError(t *testing.T) {
	installFakeDisk(t, 4<<21)
	resizeFS = func(string, uint64) error { return unix.EINVAL }
	if err := Grow("/"); !errors.Is(err, unix.EINVAL) {
		t.Fatalf("err = %v, want EINVAL", err)
	}
}
