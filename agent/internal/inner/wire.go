// Package inner runs user code in a container inside the guest: its own
// mount, PID and cgroup namespaces over the user disk. The agent stays
// outside it, so a user who kills every process, removes / or reboots
// breaks only the container (docs/architecture/agent.md#the-inner-container).
//
// The container's PID 1 is `imp-agent inner`. Go cannot join a mount
// namespace (every thread shares fs_struct), so that process also starts
// every user process for the agent: the agent sends it a spec and fds over
// a SOCK_SEQPACKET socketpair, and it reports each exit back.
package inner

import (
	"encoding/json"
	"errors"
	"fmt"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proc"
)

// Command is the agent's argument for the inner init.
const Command = "inner"

// sockFd is where the inner init finds its end of the socketpair.
const sockFd = 3

// maxMessage bounds one message: an exec's argv and env, with room.
const maxMessage = 4 << 20

// The ops on the socket. The agent sends spawn and signal; the inner init
// answers each by id, and sends ready once and exit for each spawned child.
const (
	opReady  = "ready"
	opSpawn  = "spawn"
	opSignal = "signal"
	opReply  = "reply"
	opExit   = "exit"
)

type message struct {
	ID uint64 `json:"id,omitempty"`
	Op string `json:"op"`

	// spawn
	Spec *wireSpec `json:"spec,omitempty"`

	// signal; reply to spawn; exit
	Pid   int  `json:"pid,omitempty"`
	Sig   int  `json:"sig,omitempty"`
	Group bool `json:"group,omitempty"`
	// reply to spawn: the child started in the spec's cgroup
	InCgroup bool `json:"in_cgroup,omitempty"`

	// reply: an errno travels as a number, so the agent's errors.Is works
	Errno int    `json:"errno,omitempty"`
	Error string `json:"error,omitempty"`

	// exit
	Code   int `json:"code,omitempty"`
	Signal int `json:"signal,omitempty"`
}

// wireSpec is a proc.Spec without its fds, which travel as SCM_RIGHTS:
// Files first, then the cgroup when HasCgroup.
type wireSpec struct {
	Argv      []string  `json:"argv"`
	Env       []string  `json:"env"`
	Dir       string    `json:"dir,omitempty"`
	Workdir   string    `json:"workdir,omitempty"`
	User      string    `json:"user,omitempty"`
	Cred      *wireCred `json:"cred,omitempty"`
	SetHome   bool      `json:"set_home,omitempty"`
	TTY       bool      `json:"tty,omitempty"`
	Helper    bool      `json:"helper,omitempty"`
	Files     int       `json:"files"`
	HasCgroup bool      `json:"has_cgroup,omitempty"`
}

type wireCred struct {
	Uid    uint32   `json:"uid"`
	Gid    uint32   `json:"gid"`
	Groups []uint32 `json:"groups"`
}

func toWire(s proc.Spec) *wireSpec {
	w := &wireSpec{
		Argv: s.Argv, Env: s.Env, Dir: s.Dir, Workdir: s.Workdir, User: s.User,
		SetHome: s.SetHome, TTY: s.TTY, Helper: s.Helper, Files: len(s.Files),
		HasCgroup: s.Cgroup != nil,
	}
	if s.Cred != nil {
		w.Cred = &wireCred{Uid: s.Cred.Uid, Gid: s.Cred.Gid, Groups: s.Cred.Groups}
	}
	return w
}

// send writes one message with fds. SOCK_SEQPACKET keeps each message and
// its fds together.
func send(sock int, m message, fds []int) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > maxMessage {
		return fmt.Errorf("a %s message of %d bytes passes the %d-byte limit", m.Op, len(b), maxMessage)
	}
	var oob []byte
	if len(fds) > 0 {
		oob = unix.UnixRights(fds...)
	}
	for {
		err := unix.Sendmsg(sock, b, oob, nil, 0)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return err
	}
}

// newBuffer is the space one recv reads into; each socket's one reader
// keeps its own.
func newBuffer() []byte { return make([]byte, maxMessage) }

// recv reads one message and the fds that came with it, close-on-exec.
func recv(sock int, buf []byte) (message, []int, error) {
	oob := make([]byte, unix.CmsgSpace(64*4))
	for {
		n, oobn, flags, _, err := unix.Recvmsg(sock, buf, oob, unix.MSG_CMSG_CLOEXEC)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return message{}, nil, err
		}
		fds := parseRights(oob[:oobn])
		if n == 0 {
			closeAll(fds)
			return message{}, nil, errClosed
		}
		if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 {
			closeAll(fds)
			return message{}, nil, errors.New("a message was cut short")
		}
		var m message
		if err := json.Unmarshal(buf[:n], &m); err != nil {
			closeAll(fds)
			return message{}, nil, err
		}
		return m, fds, nil
	}
}

var errClosed = errors.New("the inner container's socket closed")

// newSocketpair makes the SEQPACKET pair, with buffers that fit the largest
// message: one message must fit in the socket's buffer whole.
func newSocketpair() ([2]int, error) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return pair, err
	}
	for _, fd := range pair {
		// FORCE passes rmem_max and wmem_max; the agent is root
		unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_SNDBUFFORCE, 2*maxMessage)
		unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVBUFFORCE, 2*maxMessage)
	}
	return pair, nil
}

func parseRights(oob []byte) []int {
	msgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	var fds []int
	for _, m := range msgs {
		if got, err := unix.ParseUnixRights(&m); err == nil {
			fds = append(fds, got...)
		}
	}
	return fds
}

func closeAll(fds []int) {
	for _, fd := range fds {
		unix.Close(fd)
	}
}

// errnoOf turns an error into the number that travels in a reply.
func errnoOf(err error) int {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return int(errno)
	}
	return 0
}

// replyErr rebuilds a reply's error: the errno when there is one, so
// syscall.ESRCH stays itself.
func replyErr(m message) error {
	switch {
	case m.Error == "" && m.Errno == 0:
		return nil
	case m.Errno != 0 && m.Error == "":
		return syscall.Errno(m.Errno)
	case m.Errno != 0:
		return fmt.Errorf("%s: %w", m.Error, syscall.Errno(m.Errno))
	default:
		return errors.New(m.Error)
	}
}
