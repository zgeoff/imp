package boot

import (
	"crypto/rand"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"github.com/mdlayher/vsock"
	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/cgroup"
	"github.com/zgeoff/imp/agent/internal/cmdline"
	"github.com/zgeoff/imp/agent/internal/dial"
	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/inner"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/listen"
	"github.com/zgeoff/imp/agent/internal/netcfg"
	"github.com/zgeoff/imp/agent/internal/outer"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/pty"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/safe"
	"github.com/zgeoff/imp/agent/internal/server"
	"github.com/zgeoff/imp/agent/internal/services"
	"github.com/zgeoff/imp/agent/internal/session"
)

// Run is PID 1 from the system drive. It mounts the agent's world and the
// user disk, starts the inner container on it, configures the hostname and
// network, starts services, and serves the host on vsock. It returns only on
// failure.
func Run() error {
	r := reaper.New()

	if err := setupAgentWorld(); err != nil {
		return err
	}
	protectAgent()
	if err := setupUserCgroup(); err != nil {
		return err
	}
	params, err := cmdline.Read()
	if err != nil {
		return err
	}
	if follow := memoryFollower(params); follow != nil {
		go follow()
	}
	// a boot template parks here, before the user disk is touched; the
	// restored copy goes on with its claim's values, never the template's
	// cmdline
	claimed := params.Template
	if params.Template {
		claim, err := parkForClaim(listenVsock, applyClaim)
		if err != nil {
			return err
		}
		params = claimParams(claim)
	}
	if err := mountUserDisk(); err != nil {
		return err
	}
	// Problems below are logged, not fatal: an agent that answers on vsock
	// with a broken network or a dead container is still reachable to debug.
	if params.Hostname != "" {
		if err := unix.Sethostname([]byte(params.Hostname)); err != nil {
			log.Printf("hostname: %v", err)
		}
	}
	if err := netcfg.Up("eth0", params.IP, params.GW); err != nil {
		log.Printf("network: %v", err)
	}
	if err := netcfg.Up6("eth0", params.IP6, params.GW6); err != nil {
		log.Printf("network (IPv6): %v", err)
	}

	mgr := inner.New(r, inner.Config{RunSize: innerRunSize()})
	root := mgr.Root()
	image := imagecfg.NewLive(imagecfg.Config{})
	sup := services.New(mgr, root, image)
	launcher := launch.New(mgr, image, func() (*os.File, *os.File, error) { return pty.OpenIn(root) })
	dialer := dial.NewDialer(mgr, image)
	listener := listen.NewManager(listen.AgentRoot, listen.ForwardRoot, image, dialer, root)

	// The services and the sockets in the old container's /run went with
	// it. A new container gets its files set and its image config read
	// again, as at boot, and its services.
	mgr.OnDown(func() {
		listener.CloseLost()
		sup.Suspend()
	})
	mgr.OnUp(func() {
		prepareRoot(root, params, image)
		if err := sup.Reload(); err != nil {
			log.Printf("services: %v", err)
		}
	})
	// with the container down, the image config stays at its defaults
	// until it starts
	mgr.Launch()
	prepareRoot(root, params, image)
	identityReset := ""
	if params.ResetIdentity {
		identityReset = resetIdentity(mgr, root, image.Get().Env)
	}
	if err := sup.Load(); err != nil {
		log.Printf("services: %v", err)
	}

	// Each non-tty exec gets a cgroup leaf, so a stop kills its escapees too
	// (docs/architecture/agent.md#exec-cgroups).
	execCgroups, err := cgroup.NewTree(inner.ExecCgroupDir)
	if err != nil {
		log.Printf("boot: exec cgroups: %v; a stop reaches only the process group", err)
		execCgroups = nil
	}
	// An outer exec runs in the agent's world, while the container is down
	// too, in its own cgroup and memory limit or not at all.
	outerCgroups, err := outer.Setup()
	if err != nil {
		log.Printf("boot: outer exec: %v; every one is refused", err)
	}
	outerRunner := outer.Runner{Next: &proc.Direct{Reaper: r, Agent: inner.AgentBinary}}
	bootID := readBootID()
	if claimed {
		bootID = newBootID()
	}
	srv := &server.Server{
		Exec:     exec.NewManager(launcher, execCgroups),
		Outer:    exec.NewStrictManager(launch.New(outerRunner, outer.Image(), pty.Open), outerCgroups),
		Sessions: session.NewManager(launcher, bootID),
		Services: sup,
		Listen:   listener,
		Dial:     dialer,
		Inner: func() *proto.InnerStatus {
			st := mgr.Status()
			return &proto.InnerStatus{Up: st.Up, Restarts: st.Restarts, LastError: st.LastErr}
		},

		IdentityReset: identityReset,
		BootID:        bootID,
	}

	// A shutdown request and a signal can race; only the first powers off.
	// A panic on the way must still end the guest, so it falls back to a
	// thaw (sync would block on a frozen disk), sync and reboot.
	powerOff := sync.OnceFunc(func() {
		defer safe.Recover("poweroff", func() {
			safe.Call("poweroff: thaw", func() { srv.ThawForPoweroff() })
			unix.Sync()
			reboot()
		})
		Poweroff(sup, mgr, srv.ThawForPoweroff)
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

// prepareRoot writes the files of the user's root that follow the imp
// rather than the image (hostname, hosts and resolv.conf), then reads the
// image config. A fork or rename gives the imp a new hostname on the same
// disk.
func prepareRoot(root fsroot.FS, params cmdline.Params, image *imagecfg.Live) {
	if name := params.Hostname; name != "" {
		if err := fsroot.WriteFileAtomic(root, "/etc/hostname", []byte(name+"\n"), 0o644); err != nil {
			log.Printf("hostname: %v", err)
		}
		if err := updateHosts(root, "/etc/hosts", name); err != nil {
			log.Printf("hosts: %v", err)
		}
	}
	if err := netcfg.WriteResolvConf(root, params.DNS); err != nil {
		log.Printf("resolv.conf: %v", err)
	}
	cfg, err := imagecfg.Load(root)
	if err != nil {
		log.Printf("%s: %v (using defaults)", imagecfg.Path, err)
	}
	image.Set(cfg)
}

// listenVsock listens on the agent's port, for a boot template parked for
// its claim and for the agent's server.
func listenVsock() (net.Listener, error) {
	l, err := vsock.Listen(server.Port, nil)
	if err != nil {
		return nil, fmt.Errorf("vsock listen: %w", err)
	}
	log.Printf("boot: ready on vsock port %d", server.Port)
	return l, nil
}

// readBootID returns the guest kernel's boot_id, which every cold boot
// changes and a wake from memory keeps. Without procfs it is "", and impd
// keeps no cold boot for it. A restored boot template has the template's.
func readBootID() string {
	b, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		log.Printf("boot: boot_id: %v", err)
		return ""
	}
	return strings.TrimSpace(string(b))
}

// newBootID names a claimed boot template's boot: each copy of the template
// shares the kernel's boot_id, so it draws a random UUID instead, after the
// claim reseeded the CRNG. A wake from memory keeps it, as it keeps boot_id.
func newBootID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
