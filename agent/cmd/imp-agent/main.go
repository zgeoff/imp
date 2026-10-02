// Command imp-agent is PID 1 inside every imp guest. The kernel starts it
// from the system drive; it mounts the user disk and runs user code in a
// container over it, whose PID 1 is "imp-agent inner".
// See docs/architecture/agent.md#boot.
// "imp-agent sftp" is an SFTP server on stdio for impd's SSH gateway,
// "imp-agent dial-unix <path>" connects to a unix socket as the image USER
// for the agent's dial op, "imp-agent listen-as-user" binds a reverse
// forward's socket as that user, "imp-agent tar" is the guest end of
// `imp cp`, and "imp-agent outer" starts an outer exec's command.
package main

import (
	"fmt"
	"log"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/boot"
	"github.com/zgeoff/imp/agent/internal/dial"
	"github.com/zgeoff/imp/agent/internal/inner"
	"github.com/zgeoff/imp/agent/internal/outer"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/sftpserver"
	"github.com/zgeoff/imp/agent/internal/tartool"
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
	case len(os.Args) == 4 && os.Args[1] == dial.ListenCommand:
		// the same, to bind a reverse forward's socket
		if err := dial.RunListenHelper(os.Args[2], os.Args[3]); err != nil {
			os.Exit(1)
		}
		return
	case len(os.Args) > 1 && os.Args[1] == "tar":
		// not PID 1: impd runs it as root for `imp cp`
		if err := tartool.Run(os.Args[2:], os.Stdin, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintf(os.Stderr, "imp-agent tar: %v\n", err)
			os.Exit(1)
		}
		return
	case len(os.Args) > 3 && os.Args[1] == outer.Command:
		// not PID 1: the agent starts it for an outer exec, and on success
		// it becomes the command
		err := outer.RunHelper(os.Args[2:])
		fmt.Fprintf(os.Stderr, "imp-agent outer: %v\n", err)
		os.Exit(127)
	case len(os.Args) == 2 && os.Args[1] == inner.Command:
		// PID 1 of the container's namespaces, never of the guest: on failure
		// it exits, and the agent starts the container again
		if err := inner.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "imp-agent inner: %v\n", err)
		}
		os.Exit(1)
	case os.Getpid() == 1:
		err = boot.Run()
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
