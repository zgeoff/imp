package inner

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

// Layout of the guest the inner init sets up. The agent's own world is the
// system drive at /, with the user disk at UserRoot.
const (
	UserRoot = "/user"
	// SysMount is where the system drive shows inside, read-only: images and
	// impd run /run/imp/sys/imp-agent sftp and the like.
	SysMount = "/run/imp/sys"
	// AgentBinary is the agent on the system drive.
	AgentBinary = "/imp-agent"
)

// Config is what the agent tells the inner init through its environment.
type Config struct {
	// RunSize is the size= of the inner /run tmpfs.
	RunSize string
}

const runSizeEnv = "IMP_INNER_RUN_SIZE"

// Run is the inner init: PID 1 of the container's namespaces. It sets up
// the user's root, pivots into it, and serves the agent on fd 3. It
// returns only on failure; the agent restarts the container then.
func Run() error {
	// The socket stays the init's own: a process it starts must never
	// inherit it, or it could spawn as root and forge exits.
	unix.CloseOnExec(sockFd)
	// The agent runs at -1000, which a fork inherits: the container's
	// processes must stay fair game for the OOM killer.
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("0"), 0); err != nil {
		return fmt.Errorf("oom_score_adj: %w", err)
	}
	ignoreSignals()
	agentFile, err := setupRoot(os.Getenv(runSizeEnv))
	if err != nil {
		return err
	}
	if err := setupCgroup(); err != nil {
		return err
	}
	r := reaper.New()
	runner := &proc.Direct{Reaper: r, Agent: SysMount + AgentBinary, AgentFile: agentFile}
	return serve(sockFd, runner)
}

// ignoreSignals makes the inner init deaf to signals from inside. The kernel
// spares a namespace's init only the signals it has no handler for, and the
// Go runtime installs a handler for nearly every one: a `kill -TERM 1` would
// end it. The init takes each signal and drops it; one sent by a process,
// even a SIGSEGV, never crashes the runtime. Not signal.Ignore: an ignored
// signal stays ignored across exec, in every process the init starts.
// SIGCHLD stays for the reaper; SIGURG is the runtime's own preemption
// signal, and harmless.
func ignoreSignals() {
	var sigs []os.Signal
	for sig := syscall.Signal(1); sig <= 64; sig++ {
		switch sig {
		case syscall.SIGKILL, syscall.SIGSTOP, syscall.SIGCHLD, syscall.SIGURG:
			continue
		}
		sigs = append(sigs, sig)
	}
	ch := make(chan os.Signal, 16)
	signal.Notify(ch, sigs...)
	go func() {
		for range ch {
		}
	}()
}

// setupRoot builds the user's root on UserRoot in this mount namespace and
// pivots into it. It returns an fd of the agent binary opened before the
// pivot, for helpers.
func setupRoot(runSize string) (*os.File, error) {
	// nothing here propagates back to the agent's namespace
	if err := unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""); err != nil {
		return nil, fmt.Errorf("make / private: %w", err)
	}
	agent, err := os.Open(AgentBinary)
	if err != nil {
		return nil, err
	}
	n := UserRoot
	// pivot_root wants the new root to be a mount point of its own
	if err := unix.Mount(n, n, "", unix.MS_BIND, ""); err != nil {
		return nil, fmt.Errorf("bind %s: %w", n, err)
	}
	runData := "mode=0755"
	if runSize != "" {
		runData += ",size=" + runSize
	}
	mounts := []struct {
		source, target, fstype string
		flags                  uintptr
		data                   string
	}{
		{"proc", "/proc", "proc", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, ""},
		{"sysfs", "/sys", "sysfs", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, ""},
		{"cgroup2", "/sys/fs/cgroup", "cgroup2", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC | unix.MS_RELATIME, ""},
		// a copy of the agent's /dev, filled below: the kernel has one
		// devtmpfs, and a node deleted inside must not go for the agent
		{"tmpfs", "/dev", "tmpfs", unix.MS_NOSUID, "mode=0755,size=64k"},
		{"devpts", "/dev/pts", "devpts", unix.MS_NOSUID | unix.MS_NOEXEC, "newinstance,ptmxmode=0666,mode=0620,gid=5"},
		{"shm", "/dev/shm", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=1777"},
		// fresh every start, as /run is every boot
		{"tmpfs", "/run", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, runData},
	}
	for _, m := range mounts {
		target := n + m.target
		if err := os.MkdirAll(target, 0o755); err != nil {
			return nil, err
		}
		if err := unix.Mount(m.source, target, m.fstype, m.flags, m.data); err != nil {
			return nil, fmt.Errorf("mount %s on %s: %w", m.fstype, m.target, err)
		}
		if m.target == "/dev" {
			if err := copyDev("/dev", target); err != nil {
				return nil, fmt.Errorf("copy /dev: %w", err)
			}
		}
	}
	if err := linkDev(n + "/dev"); err != nil {
		return nil, err
	}
	// the system drive, without the agent's mounts under it (no MS_REC)
	if err := os.MkdirAll(n+SysMount, 0o755); err != nil {
		return nil, err
	}
	if err := unix.Mount("/", n+SysMount, "", unix.MS_BIND, ""); err != nil {
		return nil, fmt.Errorf("bind the system drive: %w", err)
	}
	if err := unix.Mount("", n+SysMount, "", unix.MS_REMOUNT|unix.MS_BIND|unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV, ""); err != nil {
		return nil, fmt.Errorf("remount the system drive read-only: %w", err)
	}
	if err := pivot(n); err != nil {
		return nil, err
	}
	return agent, nil
}

// pivot makes dir the root and drops the old one, so nothing of the agent's
// world stays reachable from inside.
func pivot(dir string) error {
	if err := unix.Chdir(dir); err != nil {
		return err
	}
	if err := unix.PivotRoot(".", "."); err != nil {
		return fmt.Errorf("pivot_root: %w", err)
	}
	if err := unix.Unmount(".", unix.MNT_DETACH); err != nil {
		return fmt.Errorf("detach the old root: %w", err)
	}
	return unix.Chdir("/")
}

// copyDev makes in dst the device nodes, directories and links of src, the
// agent's devtmpfs, with their modes and owners. Mount points under it
// (pts, shm) are left out: the container mounts its own.
func copyDev(src, dst string) error {
	var root unix.Stat_t
	if err := unix.Lstat(src, &root); err != nil {
		return err
	}
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == src {
			return err
		}
		var st unix.Stat_t
		if err := unix.Lstat(p, &st); err != nil {
			return nil
		}
		if st.Dev != root.Dev {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := dst + strings.TrimPrefix(p, src)
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			if err := unix.Mkdir(target, st.Mode&0o7777); err != nil && !errors.Is(err, fs.ErrExist) {
				return err
			}
		case unix.S_IFLNK:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, target); err != nil {
				return err
			}
		case unix.S_IFCHR, unix.S_IFBLK:
			if err := unix.Mknod(target, st.Mode, int(st.Rdev)); err != nil {
				return err
			}
		default:
			return nil
		}
		if err := unix.Lchown(target, int(st.Uid), int(st.Gid)); err != nil {
			return err
		}
		if st.Mode&unix.S_IFMT == unix.S_IFLNK {
			return nil
		}
		// past the umask, which mknod and mkdir applied
		return unix.Chmod(target, st.Mode&0o7777)
	})
}

// linkDev points /dev/ptmx at this devpts instance and adds the links udev
// would make.
func linkDev(dev string) error {
	links := [][2]string{
		{"pts/ptmx", "/ptmx"},
		{"/proc/self/fd", "/fd"},
		{"/proc/self/fd/0", "/stdin"},
		{"/proc/self/fd/1", "/stdout"},
		{"/proc/self/fd/2", "/stderr"},
	}
	for _, l := range links {
		if err := os.Remove(dev + l[1]); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.Symlink(l[0], dev+l[1]); err != nil {
			return err
		}
	}
	return nil
}

// setupCgroup moves the init into /init, a leaf, and gives the namespace's
// root every controller. The root then holds no process, so dockerd can
// make its own cgroups under it, as in docker-in-docker.
func setupCgroup() error {
	const root = "/sys/fs/cgroup"
	if err := os.MkdirAll(root+"/init", 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(root+"/init/cgroup.procs", []byte("0"), 0); err != nil {
		return fmt.Errorf("move into /init: %w", err)
	}
	controllers, err := os.ReadFile(root + "/cgroup.controllers")
	if err != nil {
		return err
	}
	var enable []string
	for _, c := range strings.Fields(string(controllers)) {
		enable = append(enable, "+"+c)
	}
	if len(enable) > 0 {
		if err := os.WriteFile(root+"/cgroup.subtree_control", []byte(strings.Join(enable, " ")), 0); err != nil {
			// a controller the guest kernel lacks must not stop the boot
			log.Printf("inner: enable %v: %v", enable, err)
		}
	}
	return nil
}
