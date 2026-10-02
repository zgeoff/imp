package boot

import (
	"log"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/inner"
	"github.com/zgeoff/imp/agent/internal/services"
)

const killGrace = 3 * time.Second

// Poweroff thaws the user disk, stops services, terminates every other
// process and the inner container, syncs, and reboots the guest. Firecracker
// has no power-off device; with reboot=k on the kernel cmdline a reboot
// resets through the i8042 controller, which makes Firecracker exit.
//
// The thaw comes first: on a frozen disk a service's SIGTERM handler, sync
// and the read-only remount all block until the freeze's auto-thaw.
func Poweroff(sup *services.Supervisor, mgr *inner.Manager, thaw func() error) {
	if err := thaw(); err != nil {
		log.Printf("poweroff: thaw: %v", err)
	}
	sup.StopAll()

	// the inner init ignores SIGTERM; the processes under it get it
	unix.Kill(-1, unix.SIGTERM)
	deadline := time.Now().Add(killGrace)
	for userProcesses(mgr.InitPid()) > 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	// no restart after this
	mgr.Stop()
	unix.Kill(-1, unix.SIGKILL)

	unix.Sync()
	if err := unix.Mount("", inner.UserRoot, "", unix.MS_REMOUNT|unix.MS_RDONLY, ""); err != nil {
		log.Printf("remount %s ro: %v", inner.UserRoot, err)
	}
	log.Printf("powering off")
	reboot()
}

// reboot resets the guest and never returns. RESTART, not POWER_OFF: see
// Poweroff.
func reboot() {
	if err := unix.Reboot(unix.LINUX_REBOOT_CMD_RESTART); err != nil {
		log.Printf("reboot: %v", err)
	}
	select {}
}

// userProcesses counts live processes other than PID 1 and skip. Kernel
// threads and zombies have an empty cmdline and are skipped.
func userProcesses(skip int) int {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == 1 || pid == skip {
			continue
		}
		if b, err := os.ReadFile("/proc/" + e.Name() + "/cmdline"); err == nil && len(b) > 0 {
			n++
		}
	}
	return n
}
