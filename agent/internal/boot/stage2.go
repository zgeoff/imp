package boot

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/mdlayher/vsock"
	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/cmdline"
	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/netcfg"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/server"
	"github.com/zgeoff/imp/agent/internal/services"
)

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

	l, err := vsock.Listen(server.Port, nil)
	if err != nil {
		return fmt.Errorf("vsock listen: %w", err)
	}
	srv := &server.Server{
		Exec:     exec.NewManager(r, image),
		Services: sup,
		Shutdown: func() { Poweroff(sup) },
	}

	// Ctrl-Alt-Del (Firecracker's SendCtrlAltDel) arrives as SIGINT once
	// CAD is off; SIGTERM is the conventional "stop" for init.
	if err := unix.Reboot(unix.LINUX_REBOOT_CMD_CAD_OFF); err != nil {
		log.Printf("cad off: %v", err)
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigs
		log.Printf("%v: shutting down", sig)
		Poweroff(sup)
	}()

	log.Printf("stage2: ready on vsock port %d", server.Port)
	return srv.Serve(l)
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
	// OCI exports leave /etc/hosts empty (Docker bind-mounts it at run
	// time). Only fill it in if the image did not ship one.
	if fi, err := os.Stat("/etc/hosts"); err == nil && fi.Size() > 0 {
		return nil
	}
	hosts := "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\t" + name + "\n"
	return os.WriteFile("/etc/hosts", []byte(hosts), 0o644)
}
