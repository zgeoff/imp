// Package disk grows the guest's ext4 root to the size of its block device.
// The host grows the disk file; the filesystem follows with an online resize,
// so no resize2fs is needed in the image.
package disk

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// _IOW('f', 16, __u64); x/sys/unix lacks it.
const ext4ResizeFS = 0x40086610

const pollInterval = 20 * time.Millisecond

// SizePath is the user disk's size in 512-byte sectors.
var SizePath = "/sys/block/vda/size"

// resizeFS and blockSize are variables so tests can run without an ext4 root.
var (
	resizeFS  = ioctlResize
	blockSize = statBlockSize
)

// Grow resizes the ext4 filesystem mounted at mountpoint to fill the device.
// ext4 does nothing when the size is the same.
func Grow(mountpoint string) error {
	bytes, err := readDeviceBytes()
	if err != nil {
		return err
	}
	return growTo(mountpoint, bytes)
}

// WaitAndGrow waits until the device reports at least target bytes, then
// grows the filesystem at mountpoint. After the host changes the drive, the
// guest reads the new capacity on its own time.
func WaitAndGrow(mountpoint string, target int64, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		bytes, err := readDeviceBytes()
		if err != nil {
			return err
		}
		if bytes >= target {
			return growTo(mountpoint, bytes)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the disk is %d bytes after %s, not %d", bytes, timeout, target)
		}
		time.Sleep(pollInterval)
	}
}

func growTo(mountpoint string, bytes int64) error {
	size, err := blockSize(mountpoint)
	if err != nil {
		return err
	}
	if err := resizeFS(mountpoint, uint64(bytes/size)); err != nil {
		return fmt.Errorf("EXT4_IOC_RESIZE_FS to %d bytes: %w", bytes, err)
	}
	return nil
}

func readDeviceBytes() (int64, error) {
	raw, err := os.ReadFile(SizePath)
	if err != nil {
		return 0, err
	}
	sectors, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", SizePath, err)
	}
	return sectors * 512, nil
}

func statBlockSize(mountpoint string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(mountpoint, &st); err != nil {
		return 0, err
	}
	return st.Bsize, nil
}

func ioctlResize(mountpoint string, blocks uint64) error {
	f, err := os.Open(mountpoint)
	if err != nil {
		return err
	}
	defer f.Close()
	// the argument is a pointer to the new block count, a __u64
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, f.Fd(), ext4ResizeFS, uintptr(unsafe.Pointer(&blocks)))
	if errno != 0 {
		return errno
	}
	return nil
}
