// Package pty opens pseudo-terminals for exec and sessions.
package pty

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

// Open returns a pty master and slave. It does its own ioctls instead of
// using creack/pty because that library calls File.Fd on the master, which
// switches the fd to blocking mode and disables read deadlines. Exec and
// sessions need deadlines to stop draining output once the process exits.
func Open() (master, slave *os.File, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	var n uint32
	err = control(master, func(fd int) error {
		if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
			return fmt.Errorf("unlockpt: %w", err)
		}
		var err error
		n, err = unix.IoctlGetUint32(fd, unix.TIOCGPTN)
		return err
	})
	if err != nil {
		master.Close()
		return nil, nil, err
	}
	slave, err = os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		return nil, nil, err
	}
	return master, slave, nil
}

// OpenIn opens a pty on the devpts instance at <fsys>/dev/pts, such as the
// inner container's, which its processes use as their controlling
// terminal. The slave comes from the master (TIOCGPTPEER), not from a path.
func OpenIn(fsys fsroot.FS) (master, slave *os.File, err error) {
	master, err = fsys.OpenFile("/dev/pts/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	sfd := -1
	err = control(master, func(fd int) error {
		if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
			return fmt.Errorf("unlockpt: %w", err)
		}
		r, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), unix.TIOCGPTPEER,
			uintptr(unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC))
		if errno != 0 {
			return fmt.Errorf("TIOCGPTPEER: %w", errno)
		}
		sfd = int(r)
		return nil
	})
	if err != nil {
		master.Close()
		return nil, nil, err
	}
	return master, os.NewFile(uintptr(sfd), "pty"), nil
}

// SetWinsize sets the terminal size. The kernel sends SIGWINCH to the
// foreground process group only when the size changes.
func SetWinsize(master *os.File, cols, rows uint16) error {
	return control(master, func(fd int) error {
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: rows})
	})
}

// control runs fn on f's fd without taking it out of non-blocking mode.
func control(f *os.File, fn func(fd int) error) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var ferr error
	if err := rc.Control(func(fd uintptr) { ferr = fn(int(fd)) }); err != nil {
		return err
	}
	return ferr
}
