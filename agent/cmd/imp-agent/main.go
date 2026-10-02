// Command imp-agent is PID 1 inside every imp guest. The kernel starts it
// from the system drive (stage 1); it switches root to the user disk and
// re-execs itself as "imp-agent stage2". See docs/architecture/agent.md ("Boot").
// "imp-agent sftp" is an SFTP server on stdio for impd's SSH gateway, and
// "imp-agent dial-unix <path>" connects to a unix socket as the image USER
// for the agent's dial op.
package main

import (
	"fmt"
	"log"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/boot"
	"github.com/zgeoff/imp/agent/internal/dial"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/sftpserver"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("imp-agent: ")

	var err error
	switch {
	case len(os.Args) > 1 && os.Args[1] == "version":
		fmt.Println(proto.Version)
		return
	case len(os.Args) > 1 && os.Args[1] == "sftp":
		// not PID 1: an exec of impd's SSH gateway. It must never reach the
		// reboot below, which a root user could run.
		if err := sftpserver.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "imp-agent sftp: %v\n", err)
			os.Exit(1)
		}
		return
	case len(os.Args) == 3 && os.Args[1] == dial.HelperCommand:
		// not PID 1 either: the agent starts it as the image USER
		if err := dial.RunHelper(os.Args[2]); err != nil {
			os.Exit(1)
		}
		return
	case len(os.Args) > 1 && os.Args[1] == "stage2":
		err = boot.Stage2()
	case os.Getpid() == 1:
		err = boot.Stage1()
	default:
		fmt.Fprintln(os.Stderr, "imp-agent runs as PID 1 in an imp guest")
		os.Exit(2)
	}

	// PID 1 exiting panics the kernel. Reboot instead so Firecracker exits
	// cleanly, after a pause that keeps the message on the console.
	log.Printf("fatal: %v", err)
	time.Sleep(time.Second)
	unix.Reboot(unix.LINUX_REBOOT_CMD_RESTART)
}
