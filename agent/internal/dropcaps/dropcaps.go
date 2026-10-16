// Package dropcaps starts an exec without the capabilities that let root in
// the inner container change the read-only files: CAP_SYS_ADMIN, which
// remounts their bind writable or unmounts it, and CAP_SYS_PTRACE, which
// would let the command drive a process that still holds CAP_SYS_ADMIN, such
// as the container's init (docs/architecture/guest/agent.md#read-only-files).
//
// Go's ForkExec cannot drop a capability from one child's bounding set, so
// the child starts as a helper, the agent binary itself, which drops them on
// the thread it then execs the command from. The pid, the pty, the process
// group and the cgroup leaf stay the command's.
package dropcaps

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// Command is the helper: imp-agent drop-sys-admin <agent fd> <cred> <path>
// <argv...>.
const Command = "drop-sys-admin"

// Dropped are the capabilities the command and everything it starts lack.
var Dropped = []uintptr{unix.CAP_SYS_ADMIN, unix.CAP_SYS_PTRACE}

// Argv is the helper's argv for the command at path. agentFd is the child's
// fd of the agent binary that the helper runs from, or -1; the helper closes
// it on the exec, so the command does not hold it. A nil cred runs the
// command as root; the helper itself always starts as root, since a process
// that has given up root can no longer change its bounding set.
func Argv(agentFd int, cred *syscall.Credential, path string, argv []string) []string {
	fd := "-"
	if agentFd >= 0 {
		fd = strconv.Itoa(agentFd)
	}
	return append([]string{"imp-agent", Command, fd, formatCred(cred), path}, argv...)
}

// RunHelper is the helper's body, with the arguments after Command. On
// success it does not return: it becomes the command.
func RunHelper(args []string) error {
	if len(args) < 4 {
		return errors.New("usage: imp-agent " + Command + " <agent fd> <cred> <path> <argv...>")
	}
	// the bounding set and the capability sets are per thread, and the exec
	// keeps only the calling thread's
	runtime.LockOSThread()
	if args[0] != "-" {
		fd, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("agent fd %q: %w", args[0], err)
		}
		unix.CloseOnExec(fd)
	}
	cred, err := parseCred(args[1])
	if err != nil {
		return err
	}
	if err := Drop(); err != nil {
		return err
	}
	if cred != nil {
		if err := setCred(cred); err != nil {
			return err
		}
	}
	return unix.Exec(args[2], args[3:], os.Environ())
}

// Drop takes Dropped out of the calling thread's bounding set, then out of
// its effective, permitted and inheritable sets, which takes them out of the
// ambient set too. A root exec after it gets its permitted set from the
// bounding set, so neither the command nor a setuid binary it runs gets one
// back. The caller locks its OS thread.
func Drop() error {
	for _, c := range Dropped {
		if err := unix.Prctl(unix.PR_CAPBSET_DROP, c, 0, 0, 0); err != nil {
			return fmt.Errorf("drop capability %d from the bounding set: %w", c, err)
		}
	}
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var data [2]unix.CapUserData
	if err := unix.Capget(&hdr, &data[0]); err != nil {
		return fmt.Errorf("capget: %w", err)
	}
	for _, c := range Dropped {
		bit := uint32(1) << (c % 32)
		data[c/32].Effective &^= bit
		data[c/32].Permitted &^= bit
		data[c/32].Inheritable &^= bit
	}
	if err := unix.Capset(&hdr, &data[0]); err != nil {
		return fmt.Errorf("capset: %w", err)
	}
	return nil
}

// formatCred is "" for root, else "uid:gid:group,group".
func formatCred(cred *syscall.Credential) string {
	if cred == nil {
		return ""
	}
	groups := make([]string, len(cred.Groups))
	for i, g := range cred.Groups {
		groups[i] = strconv.FormatUint(uint64(g), 10)
	}
	return fmt.Sprintf("%d:%d:%s", cred.Uid, cred.Gid, strings.Join(groups, ","))
}

func parseCred(s string) (*syscall.Credential, error) {
	if s == "" {
		return nil, nil
	}
	parts := strings.Split(s, ":")
	if len(parts) != 3 {
		return nil, fmt.Errorf("cred %q is not uid:gid:groups", s)
	}
	uid, err := strconv.ParseUint(parts[0], 10, 32)
	if err != nil {
		return nil, fmt.Errorf("cred %q: %w", s, err)
	}
	gid, err := strconv.ParseUint(parts[1], 10, 32)
	if err != nil {
		return nil, fmt.Errorf("cred %q: %w", s, err)
	}
	cred := &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: []uint32{}}
	if parts[2] != "" {
		for _, g := range strings.Split(parts[2], ",") {
			n, err := strconv.ParseUint(g, 10, 32)
			if err != nil {
				return nil, fmt.Errorf("cred %q: %w", s, err)
			}
			cred.Groups = append(cred.Groups, uint32(n))
		}
	}
	return cred, nil
}

// setCred becomes the user as ForkExec's Credential would: groups, then the
// gid, then the uid, which clears what is left of root's capabilities.
func setCred(cred *syscall.Credential) error {
	groups := make([]int, len(cred.Groups))
	for i, g := range cred.Groups {
		groups[i] = int(g)
	}
	if err := syscall.Setgroups(groups); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	if err := syscall.Setgid(int(cred.Gid)); err != nil {
		return fmt.Errorf("setgid: %w", err)
	}
	if err := syscall.Setuid(int(cred.Uid)); err != nil {
		return fmt.Errorf("setuid: %w", err)
	}
	return nil
}
