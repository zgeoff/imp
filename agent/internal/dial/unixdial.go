package dial

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
)

// A unix socket dial runs as the image's USER, the user an SSH login gets,
// so a forward reaches only the sockets that user could open. It runs in a
// helper process, `imp-agent dial-unix <path>`, not on a thread with its own
// credentials: Go moves goroutines between threads, and the server's
// SO_PEERCRED must see the user's uid and pid, not PID 1. The helper connects
// and hands the socket back over a socketpair (SCM_RIGHTS); the agent relays.

// HelperCommand is the agent's argv[1] for the helper.
const HelperCommand = "dial-unix"

// helperTimeout bounds the wait for the helper's answer: its connect never
// blocks, so the margin over dialTimeout covers the fork and exec. A
// variable for tests.
var helperTimeout = dialTimeout + 2*time.Second

// The helper's one-byte answer, then a message for an error.
const (
	answerOK         = 'k'
	answerBadRequest = 'b'
	answerFailed     = 'd'
)

// Dialer serves dial requests; unix sockets dial as user.
type Dialer struct {
	runner proc.Runner
	user   string

	// cred, when set, replaces user: tests set credentials without
	// /etc/passwd
	cred *syscall.Credential
}

// NewDialer dials unix sockets as user (the image USER spec), through
// helpers that runner starts where the sockets are: in the inner container.
func NewDialer(runner proc.Runner, user string) *Dialer {
	return &Dialer{runner: runner, user: user}
}

// openUnix connects to the socket at address as the dialer's user. Root
// connects through the helper too, so the path resolves in the user's
// world and never in the agent's.
func (d *Dialer) openUnix(address string) (net.Conn, error) {
	if !filepath.IsAbs(address) {
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "a unix socket path must be absolute (abstract sockets are not supported): " + address}
	}
	fds, err := d.runHelper([]string{HelperCommand, address}, 1, proto.ErrDialFailed)
	if err != nil {
		return nil, err
	}
	return fileConn(fds[0], address)
}

// runHelper starts `imp-agent <args>` as the dialer's user and reads its
// answer: up to max fds, the first a stream socket, or the error it met. A
// failure is failCode, or BAD_REQUEST when the helper says so.
func (d *Dialer) runHelper(args []string, max int, failCode string) ([]int, error) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, &proto.Error{Code: failCode, Message: "socketpair: " + err.Error()}
	}
	parent, child := pair[0], os.NewFile(uintptr(pair[1]), "helper")
	defer unix.Close(parent)
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		child.Close()
		return nil, &proto.Error{Code: failCode, Message: "open /dev/null: " + err.Error()}
	}
	defer devNull.Close()

	// An empty env; the socketpair end as fd 0, and /dev/null as 1 and 2, so
	// the helper's own fds land above 2 and a runtime crash message never
	// goes into the target socket.
	p, err := d.runner.Start(proc.Spec{
		Argv:   append([]string{"imp-agent"}, args...),
		Env:    []string{},
		Dir:    "/",
		User:   d.user,
		Cred:   d.cred,
		Helper: true,
		Files:  []*os.File{child, devNull, devNull},
	})
	child.Close()
	if err != nil {
		return nil, &proto.Error{Code: failCode, Message: "start the helper: " + err.Error()}
	}

	fds, err := receiveFds(parent, helperTimeout, max, failCode)
	if err != nil {
		// A helper that hangs must not outlive its request; the reaper reaps
		// it. Kill reaches only this helper, never a process that reused its
		// pid.
		p.Kill()
		return nil, err
	}
	return fds, nil
}

// receiveSocket reads a dial helper's answer: one stream socket, or the
// error it met.
func receiveSocket(conn int, timeout time.Duration) (int, error) {
	fds, err := receiveFds(conn, timeout, 1, proto.ErrDialFailed)
	if err != nil {
		return -1, err
	}
	return fds[0], nil
}

// receiveFds reads a helper's answer: up to max fds, the first a stream
// socket, or the error it met. The received fds are close-on-exec from the
// start (MSG_CMSG_CLOEXEC), so a child forked meanwhile for an exec never
// inherits them; fds past max are closed.
func receiveFds(conn int, timeout time.Duration, max int, failCode string) ([]int, error) {
	if err := waitReadable(conn, timeout, failCode); err != nil {
		return nil, err
	}
	buf := make([]byte, 4096)
	oob := make([]byte, unix.CmsgSpace(4*4))
	n, oobn, _, _, err := unix.Recvmsg(conn, buf, oob, unix.MSG_CMSG_CLOEXEC)
	if err != nil {
		return nil, &proto.Error{Code: failCode, Message: "read the helper's answer: " + err.Error()}
	}
	fds := parseRights(oob[:oobn])
	var keep []int
	if n >= 1 && buf[0] == answerOK && len(fds) >= 1 {
		keep = fds[:min(max, len(fds))]
		fds = fds[len(keep):]
	}
	for _, fd := range fds {
		unix.Close(fd)
	}

	switch {
	case n == 0:
		return nil, &proto.Error{Code: failCode, Message: "the helper exited without an answer"}
	case keep != nil:
		if !isStreamSocket(keep[0]) {
			for _, fd := range keep {
				unix.Close(fd)
			}
			return nil, &proto.Error{Code: failCode, Message: "the helper answered with something other than a stream socket"}
		}
		return keep, nil
	case buf[0] == answerBadRequest:
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: string(buf[1:n])}
	case buf[0] == answerFailed:
		return nil, &proto.Error{Code: failCode, Message: string(buf[1:n])}
	default:
		return nil, &proto.Error{Code: failCode, Message: "the helper's answer makes no sense"}
	}
}

func helperFailed(message string) error {
	return &proto.Error{Code: proto.ErrDialFailed, Message: message}
}

// waitReadable polls conn until it has data or timeout passes. A signal
// (the reaper's SIGCHLD) interrupts poll; it goes on with the time left. It
// holds an OS thread for up to helperTimeout, and the reaper runs one fork at
// a time: both fine at the rate SSH forwards open.
func waitReadable(conn int, timeout time.Duration, failCode string) error {
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return &proto.Error{Code: failCode, Message: fmt.Sprintf("the helper did not answer within %s", timeout)}
		}
		fds := []unix.PollFd{{Fd: int32(conn), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, int(left.Milliseconds())+1)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return &proto.Error{Code: failCode, Message: "poll the helper: " + err.Error()}
		}
		if n > 0 {
			return nil
		}
	}
}

func parseRights(oob []byte) []int {
	msgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	var fds []int
	for _, msg := range msgs {
		rights, err := unix.ParseUnixRights(&msg)
		if err == nil {
			fds = append(fds, rights...)
		}
	}
	return fds
}

func isStreamSocket(fd int) bool {
	typ, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_TYPE)
	return err == nil && typ == unix.SOCK_STREAM
}

// fileConn wraps a connected socket fd as a net.Conn and closes the fd;
// net.FileConn keeps its own copy.
func fileConn(fd int, address string) (net.Conn, error) {
	f := os.NewFile(uintptr(fd), "unix:"+address)
	defer f.Close()
	c, err := net.FileConn(f)
	if err != nil {
		return nil, helperFailed("wrap the socket: " + err.Error())
	}
	return c, nil
}

// connectUnix connects to the socket at address as the calling process. It
// opens the path with O_PATH and connects through /proc/self/fd, so the path
// it checks against impDir is the one it connects to.
func connectUnix(address string) (int, error) {
	pathFd, err := unix.Open(address, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, &proto.Error{Code: proto.ErrDialFailed, Message: fmt.Sprintf("open %s: %v", address, err)}
	}
	defer unix.Close(pathFd)
	procPath := fmt.Sprintf("/proc/self/fd/%d", pathFd)

	// Not a boundary: every forwarded ssh-agent socket belongs to the image
	// USER, who may reach it anyway. It keeps a root image's dial off the
	// agent's own sockets.
	real, err := os.Readlink(procPath)
	if err != nil {
		return -1, &proto.Error{Code: proto.ErrDialFailed, Message: err.Error()}
	}
	if real == impDir || strings.HasPrefix(real, impDir+"/") {
		return -1, &proto.Error{Code: proto.ErrBadRequest, Message: address + " leads to the agent's own sockets"}
	}

	sock, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK, 0)
	if err != nil {
		return -1, &proto.Error{Code: proto.ErrDialFailed, Message: "socket: " + err.Error()}
	}
	// a unix connect does not wait: a full backlog fails with EAGAIN at once
	if err := unix.Connect(sock, &unix.SockaddrUnix{Name: procPath}); err != nil {
		unix.Close(sock)
		return -1, &proto.Error{Code: proto.ErrDialFailed, Message: fmt.Sprintf("connect %s: %v", address, err)}
	}
	return sock, nil
}

// RunHelper is `imp-agent dial-unix <path>`: it connects to path as this
// process's user and answers on fd 0 with the socket or the error.
func RunHelper(address string) error {
	fd, err := connectUnix(address)
	if err != nil {
		return answer(nil, err)
	}
	return answer([]int{fd}, nil)
}

// answer is a helper's reply on fd 0: the fds, or the error as BAD_REQUEST
// or a failure.
func answer(fds []int, err error) error {
	if err == nil {
		return unix.Sendmsg(0, []byte{answerOK}, unix.UnixRights(fds...), nil, 0)
	}
	code, text := byte(answerFailed), err.Error()
	var pe *proto.Error
	if errors.As(err, &pe) {
		text = pe.Message
		if pe.Code == proto.ErrBadRequest {
			code = answerBadRequest
		}
	}
	return unix.Sendmsg(0, append([]byte{code}, text...), nil, nil, 0)
}
