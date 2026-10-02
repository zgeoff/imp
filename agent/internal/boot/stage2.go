package boot

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/mdlayher/vsock"
	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/cgroup"
	"github.com/zgeoff/imp/agent/internal/cmdline"
	"github.com/zgeoff/imp/agent/internal/dial"
	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/listen"
	"github.com/zgeoff/imp/agent/internal/netcfg"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/safe"
	"github.com/zgeoff/imp/agent/internal/server"
	"github.com/zgeoff/imp/agent/internal/services"
	"github.com/zgeoff/imp/agent/internal/session"
)

// ExecCgroupRoot holds one cgroup leaf per non-tty exec
// (docs/architecture/agent.md#exec-cgroups).
const ExecCgroupRoot = "/sys/fs/cgroup/imp-exec"

// Stage2 runs as PID 1 on the user disk. It finishes the mounts, configures
// the hostname and network, starts services, and serves the host on vsock.
// It returns only on failure.
func Stage2() error {
	r := reaper.New()

	if err := mountSystem(); err != nil {
		return err
	}
	params, err := cmdline.Read()
	if err != nil {
		return err
	}
	// Problems below are logged, not fatal: an agent that answers on vsock
	// with a broken network is still reachable to debug.
	if err := setHostname(params.Hostname); err != nil {
		log.Printf("hostname: %v", err)
	}
	if err := netcfg.Up("eth0", params.IP, params.GW); err != nil {
		log.Printf("network: %v", err)
	}
	if err := netcfg.WriteResolvConf(params.DNS); err != nil {
		log.Printf("resolv.conf: %v", err)
	}
	image, err := imagecfg.Load()
	if err != nil {
		log.Printf("%s: %v (using defaults)", imagecfg.Path, err)
	}

	sup := services.New(r, image)
	if err := sup.Load(); err != nil {
		log.Printf("services: %v", err)
	}

	listenVsock := func() (net.Listener, error) {
		l, err := vsock.Listen(server.Port, nil)
		if err != nil {
			return nil, fmt.Errorf("vsock listen: %w", err)
		}
		log.Printf("stage2: ready on vsock port %d", server.Port)
		return l, nil
	}
	launcher := launch.New(r, image)
	dialer := dial.NewDialer(r, image.User, AgentPath)
	// Each non-tty exec gets a cgroup leaf, so a stop kills its escapees too.
	execCgroups, err := cgroup.NewTree(ExecCgroupRoot)
	if err != nil {
		log.Printf("stage2: exec cgroups: %v; a stop reaches only the process group", err)
		execCgroups = nil
	}
	srv := &server.Server{
		Exec:     exec.NewManager(launcher, execCgroups),
		Sessions: session.NewManager(launcher),
		Services: sup,
		Listen:   listen.NewManager(listen.AgentRoot, listen.ForwardRoot, image.User, dialer),
		Dial:     dialer,
	}
	// A shutdown request and a signal can race; only the first powers off.
	// A panic on the way must still end the guest, so it falls back to a
	// thaw (sync would block on a frozen /), sync and reboot.
	powerOff := sync.OnceFunc(func() {
		defer safe.Recover("poweroff", func() {
			safe.Call("poweroff: thaw", func() { srv.ThawForPoweroff() })
			unix.Sync()
			reboot()
		})
		Poweroff(sup, srv.ThawForPoweroff)
	})
	srv.Shutdown = powerOff

	// Ctrl-Alt-Del (Firecracker's SendCtrlAltDel) arrives as SIGINT once
	// CAD is off; SIGTERM is the conventional "stop" for init.
	if err := unix.Reboot(unix.LINUX_REBOOT_CMD_CAD_OFF); err != nil {
		log.Printf("cad off: %v", err)
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	safe.Go("signals", func() {
		sig := <-sigs
		log.Printf("%v: shutting down", sig)
		powerOff()
	}, nil)

	return srv.Serve(listenVsock)
}

func mountSystem() error {
	if err := mountOnce("cgroup2", "/sys/fs/cgroup", "cgroup2",
		unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC|unix.MS_RELATIME, "nsdelegate"); err != nil {
		return err
	}
	if err := mkdirMount("devpts", "/dev/pts", "devpts", unix.MS_NOSUID|unix.MS_NOEXEC,
		"newinstance,ptmxmode=0666,mode=0620,gid=5"); err != nil {
		return err
	}
	if err := mkdirMount("shm", "/dev/shm", "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=1777"); err != nil {
		return err
	}
	// devtmpfs has a /dev/ptmx bound to the initial devpts instance; point
	// it at ours. The rest are links udev would normally make.
	links := [][2]string{
		{"pts/ptmx", "/dev/ptmx"},
		{"/proc/self/fd", "/dev/fd"},
		{"/proc/self/fd/0", "/dev/stdin"},
		{"/proc/self/fd/1", "/dev/stdout"},
		{"/proc/self/fd/2", "/dev/stderr"},
	}
	for _, l := range links {
		if err := os.Remove(l[1]); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := os.Symlink(l[0], l[1]); err != nil {
			return err
		}
	}
	return nil
}

func setHostname(name string) error {
	if name == "" {
		return nil
	}
	if err := unix.Sethostname([]byte(name)); err != nil {
		return err
	}
	if err := os.WriteFile("/etc/hostname", []byte(name+"\n"), 0o644); err != nil {
		return err
	}
	return updateHosts("/etc/hosts", name)
}

// updateHosts points the 127.0.1.1 line of the hosts file at name. It runs
// every boot, because a fork or rename gives the imp a new hostname on the
// same disk. OCI exports leave /etc/hosts empty (Docker bind-mounts it at
// run time), so an empty or missing file gets a default one. A symlinked
// hosts file is updated at its target; the rename must not replace the link.
func updateHosts(path, name string) error {
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&fs.ModeSymlink != 0 {
		target, err := filepath.EvalSymlinks(path)
		if err != nil {
			return fmt.Errorf("%s is a symlink that does not resolve: %w", path, err)
		}
		path = target
	}
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	out := hostsWithName(string(b), name)
	if out == string(b) {
		return nil
	}
	return writeFileAtomic(path, []byte(out), 0o644)
}

// writeFileAtomic replaces path through a temporary file and a rename, so a
// crash mid-write cannot leave it truncated.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// hostsWithName returns hosts with its first 127.0.1.1 line mapping to
// name, or with such a line appended if there is none. A line that already
// names it first keeps its aliases; later 127.0.1.1 lines are dropped.
func hostsWithName(hosts, name string) string {
	line := "127.0.1.1\t" + name
	if strings.TrimSpace(hosts) == "" {
		return "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n" + line + "\n"
	}
	lines := strings.Split(strings.TrimSuffix(hosts, "\n"), "\n")
	out := make([]string, 0, len(lines)+1)
	replaced := false
	for _, l := range lines {
		if f := strings.Fields(l); len(f) > 0 && f[0] == "127.0.1.1" {
			if !replaced {
				if len(f) > 1 && f[1] == name {
					out = append(out, l)
				} else {
					out = append(out, line)
				}
				replaced = true
			}
			continue
		}
		out = append(out, l)
	}
	if !replaced {
		out = append(out, line)
	}
	return strings.Join(out, "\n") + "\n"
}
