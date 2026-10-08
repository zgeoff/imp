package disk

import (
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"testing/synctest"
	"time"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

// fakeDisk stands in for the device size file and the resize ioctl.
type fakeDisk struct {
	sizePath string
	resized  []uint64
}

func installFakeDisk(t *testing.T, sectors int64) *fakeDisk {
	t.Helper()
	f := &fakeDisk{sizePath: filepath.Join(t.TempDir(), "size")}
	assert.NilError(t, f.setSectors(sectors))
	prevPath, prevResize, prevBlock := SizePath, resizeFS, blockSize
	t.Cleanup(func() { SizePath, resizeFS, blockSize = prevPath, prevResize, prevBlock })
	SizePath = f.sizePath
	resizeFS = func(_ string, blocks uint64) error {
		f.resized = append(f.resized, blocks)
		return nil
	}
	blockSize = func(string) (int64, error) { return 4096, nil }
	return f
}

// setSectors replaces the file in one rename: a sysfs read never sees a
// half-written value, and the poll must not either.
func (f *fakeDisk) setSectors(sectors int64) error {
	tmp := f.sizePath + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(sectors, 10)+"\n"), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, f.sizePath)
}

func TestFakeDiskWritesItsSectorsAsSysfsDoesAndRestoresTheDevice(t *testing.T) {
	var during string

	t.Run("installed", func(t *testing.T) {
		f := installFakeDisk(t, 4<<21)
		assert.NilError(t, f.setSectors(6<<21))
		b, err := os.ReadFile(SizePath)
		assert.NilError(t, err)
		during = string(b)
	})

	assert.Check(t, cmp.Equal(during, "12582912\n"))
	assert.Check(t, cmp.Equal(SizePath, "/sys/block/vda/size"))
}

func TestGrowResizesTheFilesystemToFillTheDevice(t *testing.T) {
	f := installFakeDisk(t, 8<<21) // 8 GiB

	err := Grow("/")

	assert.NilError(t, err)
	assert.DeepEqual(t, f.resized, []uint64{8 << 30 / 4096})
}

func TestGrowReportsTheIoctlError(t *testing.T) {
	installFakeDisk(t, 4<<21)
	resizeFS = func(string, uint64) error { return unix.EINVAL }

	err := Grow("/")

	assert.ErrorIs(t, err, unix.EINVAL)
}

func TestGrowReportsASizeFileThatIsNotANumber(t *testing.T) {
	f := installFakeDisk(t, 4<<21)
	assert.NilError(t, os.WriteFile(f.sizePath, []byte("lots\n"), 0o644))

	err := Grow("/")

	assert.Check(t, cmp.ErrorIs(err, strconv.ErrSyntax))
	assert.Check(t, cmp.Len(f.resized, 0))
}

func TestGrowReportsTheBlockSizeError(t *testing.T) {
	f := installFakeDisk(t, 4<<21)
	blockSize = func(string) (int64, error) { return 0, unix.ENOSYS }

	err := Grow("/")

	assert.Check(t, cmp.ErrorIs(err, unix.ENOSYS))
	assert.Check(t, cmp.Len(f.resized, 0))
}

// The size file is read and the poll sleeps in the bubble's clock; nothing
// here forks or opens a socket.
func TestWaitAndGrowWaitsForTheNewSize(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := installFakeDisk(t, 4<<21)
		start := time.Now()
		grown := make(chan error, 1)
		// the disk grows 60ms in; until then every read sees the stale 4 GiB
		go func() {
			time.Sleep(60 * time.Millisecond)
			grown <- f.setSectors(6 << 21)
		}()

		err := WaitAndGrow("/", 6<<30, 2*time.Second)
		took := time.Since(start)

		assert.NilError(t, <-grown)
		assert.Check(t, err)
		// returning only at the growth shows the earlier reads saw the stale
		// size and kept polling
		assert.Check(t, took >= 60*time.Millisecond, "returned after %s, before the disk grew", took)
		assert.Check(t, cmp.DeepEqual(f.resized, []uint64{6 << 30 / 4096}))
	})
}

func TestWaitAndGrowGivesUpAtTheDeadlineWithoutResizing(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := installFakeDisk(t, 4<<21)
		start := time.Now()

		err := WaitAndGrow("/", 6<<30, 50*time.Millisecond)

		assert.Check(t, cmp.ErrorContains(err, "the disk is 4294967296 bytes"))
		assert.Check(t, time.Since(start) >= 50*time.Millisecond, "gave up after %s", time.Since(start))
		assert.Check(t, cmp.Len(f.resized, 0))
	})
}

func TestWaitAndGrowReportsAMissingSizeFile(t *testing.T) {
	f := installFakeDisk(t, 4<<21)
	assert.NilError(t, os.Remove(f.sizePath))

	err := WaitAndGrow("/", 6<<30, time.Second)

	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
	assert.Check(t, cmp.Len(f.resized, 0))
}
