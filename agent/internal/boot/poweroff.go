package boot

import (
	"log"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/services"
)

const killGrace = 3 * time.Second

// Poweroff stops services, terminates every other process, syncs, and
// reboots the guest. Firecracker has no power-off device; with reboot=k on
// the kernel cmdline a reboot resets through the i8042 controller, which
// makes Firecracker exit.
func Poweroff(sup *services.Supervisor) {
	sup.StopAll()

	unix.Kill(-1, unix.SIGTERM)
	deadline := time.Now().Add(killGrace)
	for userProcesses() > 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	unix.Kill(-1, unix.SIGKILL)

	unix.Sync()
	if err := unix.Mount("", "/", "", unix.MS_REMOUNT|unix.MS_RDONLY, ""); err != nil {
		log.Printf("remount / ro: %v", err)
	}
	log.Printf("powering off")
	// RESTART, not POWER_OFF: see the doc comment.
	if err := unix.Reboot(unix.LINUX_REBOOT_CMD_RESTART); err != nil {
		log.Printf("reboot: %v", err)
	}
	select {}
}

// userProcesses counts live processes other than PID 1. Kernel threads and
// zombies have an empty cmdline and are skipped.
func userProcesses() int {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == 1 {
			continue
		}
		if b, err := os.ReadFile("/proc/" + e.Name() + "/cmdline"); err == nil && len(b) > 0 {
			n++
		}
	}
	return n
}
