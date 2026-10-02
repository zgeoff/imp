// Package boot brings the guest up. The agent stays on the read-only system
// drive, mounts the user disk at /user, and runs user code in the inner
// container over it (docs/architecture/agent.md#boot).
package boot

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/disk"
	"github.com/zgeoff/imp/agent/internal/inner"
)

const (
	userDisk = "/dev/vda"

	// agentRunSize caps the agent's own /run: its sockets and little else
	agentRunSize = "16m"

	// userReserve is memory the inner container's cgroup leaves to the agent
	// and the kernel, so a user process that eats all of it meets the OOM
	// killer inside its cgroup, not the agent.
	userReserve = 64 << 20
)

// setupAgentWorld mounts the agent's own filesystems on the system drive,
// which must contain the directories /dev, /proc, /sys, /run and /user,
// since it cannot be written. A boot template makes them before it parks.
func setupAgentWorld() error {
	if err := mountOnce("devtmpfs", "/dev", "devtmpfs", unix.MS_NOSUID, "mode=0755"); err != nil {
		return err
	}
	if err := mountOnce("proc", "/proc", "proc", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil {
		return err
	}
	if err := mountOnce("sysfs", "/sys", "sysfs", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil {
		return err
	}
	if err := mountOnce("cgroup2", "/sys/fs/cgroup", "cgroup2",
		unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC|unix.MS_RELATIME, "nsdelegate"); err != nil {
		return err
	}
	if err := mountOnce("tmpfs", "/run", "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0755,size="+agentRunSize); err != nil {
		return err
	}
	// the agent's own ptys, for an exec in its world
	if err := mkdirMount("devpts", "/dev/pts", "devpts", unix.MS_NOSUID|unix.MS_NOEXEC,
		"newinstance,ptmxmode=0666,mode=0620,gid=5"); err != nil {
		return err
	}
	return nil
}

// mountUserDisk mounts the user disk at UserRoot and grows it. A boot
// template does this only after its claim, so the disk it never read is the
// copy's own.
func mountUserDisk() error {
	// noinit_itable: the disk is a sparse file, so the inode tables of a grown
	// disk read as zeros already; zeroing them in the background would only
	// allocate about 1.6 % of the disk on the host
	if err := unix.Mount(userDisk, inner.UserRoot, "ext4", unix.MS_RELATIME, "noinit_itable"); err != nil {
		return fmt.Errorf("mount %s: %w", userDisk, err)
	}
	// the host may have grown the disk since the last boot; a failed grow
	// leaves the filesystem as it was, so the boot goes on
	if err := disk.Grow(inner.UserRoot); err != nil {
		log.Printf("boot: grow %s: %v", userDisk, err)
	}
	return nil
}

// protectAgent keeps the OOM killer off the agent: a user process that eats
// the guest's memory dies first.
func protectAgent() {
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("-1000"), 0); err != nil {
		log.Printf("boot: oom_score_adj: %v", err)
	}
}

// setupUserCgroup makes the inner container's cgroup with every controller
// and a memory limit that leaves userReserve to the agent and the kernel.
func setupUserCgroup() error {
	const root = "/sys/fs/cgroup"
	controllers, err := os.ReadFile(root + "/cgroup.controllers")
	if err != nil {
		return err
	}
	var enable []string
	for _, c := range strings.Fields(string(controllers)) {
		enable = append(enable, "+"+c)
	}
	if err := os.WriteFile(root+"/cgroup.subtree_control", []byte(strings.Join(enable, " ")), 0); err != nil {
		log.Printf("boot: enable %v: %v", enable, err)
	}
	if err := os.MkdirAll(inner.CgroupDir, 0o755); err != nil {
		return err
	}
	if total := memTotal(); total > 2*userReserve {
		limit := strconv.FormatInt(total-userReserve, 10)
		if err := os.WriteFile(inner.CgroupDir+"/memory.max", []byte(limit), 0); err != nil {
			log.Printf("boot: memory.max: %v", err)
		}
	}
	return nil
}

// memTotal is the guest's memory in bytes, or 0.
func memTotal() int64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[0] == "MemTotal:" {
			kib, _ := strconv.ParseInt(f[1], 10, 64)
			return kib << 10
		}
	}
	return 0
}

// innerRunSize is the inner /run's size: a tenth of memory, as a user's
// /run full of files must not take the guest's memory.
func innerRunSize() string {
	if total := memTotal(); total > 0 {
		return strconv.FormatInt(total/10, 10)
	}
	return ""
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
