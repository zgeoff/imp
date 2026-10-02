// Package boot brings the guest up. Stage 1 runs from the system drive
// and switches root to the user disk; stage 2 runs from the user disk and
// sets up the rest of the system.
package boot

import (
	"fmt"
	"log"
	"os"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/cmdline"
	"github.com/zgeoff/imp/agent/internal/disk"
)

const (
	userDisk = "/dev/vda"
	newRoot  = "/newroot"
	// SysMount is where the system drive stays visible after switch root.
	SysMount = "/run/imp/sys"
	// AgentPath is the agent binary after switch root.
	AgentPath = SysMount + "/imp-agent"
)

// Stage1 runs as PID 1 with the read-only system drive as root. It mounts
// the user disk, keeps the system drive reachable under it, switches root,
// and re-execs the agent as stage 2. The system drive must contain the
// directories /dev, /proc, /sys and /newroot, since it cannot be written.
func Stage1() error {
	if err := mountOnce("devtmpfs", "/dev", "devtmpfs", unix.MS_NOSUID, "mode=0755"); err != nil {
		return err
	}
	if err := mountOnce("proc", "/proc", "proc", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil {
		return err
	}
	if err := mountOnce("sysfs", "/sys", "sysfs", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil {
		return err
	}
	params, err := cmdline.Read()
	if err != nil {
		return err
	}
	// a boot template parks here, before the user disk is touched; the
	// restored copy goes on with its claim's values
	if params.Template {
		claim, err := parkForClaim(listenVsock, applyClaim)
		if err != nil {
			return err
		}
		params = claimParams(claim)
	}
	// noinit_itable: the disk is a sparse file, so the inode tables of a grown
	// disk read as zeros already; zeroing them in the background would only
	// allocate about 1.6 % of the disk on the host
	if err := unix.Mount(userDisk, newRoot, "ext4", unix.MS_RELATIME, "noinit_itable"); err != nil {
		return fmt.Errorf("mount %s: %w", userDisk, err)
	}
	// the host may have grown the disk since the last boot; a failed grow
	// leaves the filesystem as it was, so the boot goes on
	if err := disk.Grow(newRoot); err != nil {
		log.Printf("stage1: grow %s: %v", userDisk, err)
	}

	// /run is a fresh tmpfs every boot; the system drive is bound inside it
	// so user images never need an imp-specific mountpoint.
	if err := mkdirMount("tmpfs", newRoot+"/run", "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0755"); err != nil {
		return err
	}
	if err := os.MkdirAll(newRoot+SysMount, 0o755); err != nil {
		return err
	}
	if err := unix.Mount("/", newRoot+SysMount, "", unix.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind system drive: %w", err)
	}
	for _, d := range []string{"/dev", "/proc", "/sys"} {
		if err := os.MkdirAll(newRoot+d, 0o755); err != nil {
			return err
		}
		if err := unix.Mount(d, newRoot+d, "", unix.MS_MOVE, ""); err != nil {
			return fmt.Errorf("move %s: %w", d, err)
		}
	}

	// switch_root: the initial root cannot be pivot_root'ed away, so move
	// the new root over / and chroot into it, as busybox switch_root does.
	if err := unix.Chdir(newRoot); err != nil {
		return err
	}
	if err := unix.Mount(".", "/", "", unix.MS_MOVE, ""); err != nil {
		return fmt.Errorf("move newroot: %w", err)
	}
	if err := unix.Chroot("."); err != nil {
		return fmt.Errorf("chroot: %w", err)
	}
	if err := unix.Chdir("/"); err != nil {
		return err
	}
	log.Printf("stage1: switched root to %s", userDisk)
	return syscall.Exec(AgentPath, []string{AgentPath, "stage2", params.Encode()}, os.Environ())
}

// mountOnce mounts fstype on target unless something is already mounted
// there. The kernel auto-mounts devtmpfs on /dev (DEVTMPFS_MOUNT).
func mountOnce(source, target, fstype string, flags uintptr, data string) error {
	if mounted(target) {
		return nil
	}
	if err := unix.Mount(source, target, fstype, flags, data); err != nil {
		return fmt.Errorf("mount %s on %s: %w", fstype, target, err)
	}
	return nil
}

func mkdirMount(source, target, fstype string, flags uintptr, data string) error {
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	if err := unix.Mount(source, target, fstype, flags, data); err != nil {
		return fmt.Errorf("mount %s on %s: %w", fstype, target, err)
	}
	return nil
}

// mounted reports whether path is a mountpoint: its device differs from
// its parent's.
func mounted(path string) bool {
	var st, parent unix.Stat_t
	if unix.Stat(path, &st) != nil || unix.Stat(path+"/..", &parent) != nil {
		return false
	}
	return st.Dev != parent.Dev
}
