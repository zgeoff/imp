package dial

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// A reverse forward listens in the guest as the image's USER, as a unix dial
// connects as that user: the helper, `imp-agent listen-as-user <network>
// <address>`, binds the socket and hands it back, so a forward binds only
// where that user may, and a TCP port below 1024 fails as it would for them.

// ListenCommand is the agent's argv[1] for the listen helper.
const ListenCommand = "listen-as-user"

// listenBacklog is the queue of clients the kernel holds before an accept.
const listenBacklog = 64

// Bound is a listening socket the helper made. For a unix path, Dir holds
// the socket's directory open and Name, Dev and Ino name the socket in it,
// so the agent removes its own socket and nothing a process put there
// later. Dir is -1 for TCP.
type Bound struct {
	Listener net.Listener
	Port     int
	Dir      int
	Name     string
	Dev, Ino uint64
}

// Close stops the listener and removes the socket if it is still the one
// bound: unlinked through the directory it was bound in, so a directory
// swapped for a symlink meanwhile changes nothing.
func (b *Bound) Close() {
	b.Listener.Close()
	if b.Dir < 0 {
		return
	}
	var st unix.Stat_t
	err := unix.Fstatat(b.Dir, b.Name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if err == nil && st.Mode&unix.S_IFMT == unix.S_IFSOCK && uint64(st.Dev) == b.Dev && st.Ino == b.Ino {
		unix.Unlinkat(b.Dir, b.Name, 0)
	}
	unix.Close(b.Dir)
}

// Listen binds network and address as the dialer's user: "unix" with an
// absolute path, or "tcp" with 127.0.0.1:<port>, where port 0 takes any
// free port.
func (d *Dialer) Listen(network, address string) (*Bound, error) {
	if err := checkListenAddress(network, address); err != nil {
		return nil, err
	}
	cred, err := d.lookup(d.user)
	if err != nil {
		return nil, &proto.Error{Code: proto.ErrListenFailed, Message: fmt.Sprintf("user %q: %v", d.user, err)}
	}
	var fds []int
	if cred == nil {
		fds, err = bindSocket(network, address)
	} else {
		fds, err = d.runHelper(cred, []string{ListenCommand, network, address}, 2, proto.ErrListenFailed)
	}
	if err != nil {
		return nil, err
	}
	return wrapBound(fds, network, address)
}

func checkListenAddress(network, address string) error {
	switch network {
	case "unix":
		if !filepath.IsAbs(address) {
			return &proto.Error{Code: proto.ErrBadRequest, Message: "a unix socket path must be absolute (abstract sockets are not supported): " + address}
		}
		if filepath.Clean(address) == "/" {
			return &proto.Error{Code: proto.ErrBadRequest, Message: "a unix socket path needs a name"}
		}
		return nil
	case "tcp":
		_, err := parseLoopbackPort(address)
		return err
	default:
		return &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("network must be tcp or unix, got %q", network)}
	}
}

// parseLoopbackPort reads 127.0.0.1:<port>: a reverse forward never listens
// on an address other machines reach
func parseLoopbackPort(address string) (int, error) {
	host, portText, err := net.SplitHostPort(address)
	port, perr := strconv.Atoi(portText)
	if err != nil || host != "127.0.0.1" || perr != nil || port < 0 || port > 65535 {
		return 0, &proto.Error{Code: proto.ErrBadRequest, Message: "a tcp listen address must be 127.0.0.1:<port>, got " + address}
	}
	return port, nil
}

// wrapBound checks the helper's fds (a listening socket, and for unix its
// directory) and wraps them.
func wrapBound(fds []int, network, address string) (*Bound, error) {
	closeAll := func() {
		for _, fd := range fds {
			unix.Close(fd)
		}
	}
	failed := func(message string) (*Bound, error) {
		closeAll()
		return nil, &proto.Error{Code: proto.ErrListenFailed, Message: message}
	}
	if accepting, err := unix.GetsockoptInt(fds[0], unix.SOL_SOCKET, unix.SO_ACCEPTCONN); err != nil || accepting != 1 {
		return failed("the helper answered with a socket that does not listen")
	}
	b := &Bound{Dir: -1}
	if network == "unix" {
		if len(fds) != 2 {
			return failed("the helper answered without the socket's directory")
		}
		var dir unix.Stat_t
		if err := unix.Fstat(fds[1], &dir); err != nil || dir.Mode&unix.S_IFMT != unix.S_IFDIR {
			return failed("the helper answered with something other than a directory")
		}
		b.Dir, b.Name = fds[1], filepath.Base(filepath.Clean(address))
		var st unix.Stat_t
		if err := unix.Fstatat(b.Dir, b.Name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil || st.Mode&unix.S_IFMT != unix.S_IFSOCK {
			return failed(address + " is not the socket the helper bound")
		}
		b.Dev, b.Ino = uint64(st.Dev), st.Ino
	} else if len(fds) != 1 {
		return failed("the helper answered with more than the socket")
	}

	f := os.NewFile(uintptr(fds[0]), network+":"+address)
	ln, err := net.FileListener(f)
	f.Close()
	if err != nil {
		if b.Dir >= 0 {
			unix.Close(b.Dir)
		}
		return nil, &proto.Error{Code: proto.ErrListenFailed, Message: "wrap the listener: " + err.Error()}
	}
	b.Listener = ln
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		b.Port = addr.Port
	}
	return b, nil
}

// bindSocket binds and listens as the calling process: the listening
// socket, and for unix the directory it is in.
func bindSocket(network, address string) ([]int, error) {
	if network == "tcp" {
		fd, err := bindTCP(address)
		if err != nil {
			return nil, err
		}
		return []int{fd}, nil
	}
	return bindUnix(address)
}

func bindTCP(address string) (int, error) {
	port, err := parseLoopbackPort(address)
	if err != nil {
		return -1, err
	}
	sock, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return -1, &proto.Error{Code: proto.ErrListenFailed, Message: "socket: " + err.Error()}
	}
	unix.SetsockoptInt(sock, unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)
	err = unix.Bind(sock, &unix.SockaddrInet4{Port: port, Addr: [4]byte{127, 0, 0, 1}})
	if err == nil {
		err = unix.Listen(sock, listenBacklog)
	}
	if err != nil {
		unix.Close(sock)
		message := fmt.Sprintf("listen on %s: %v", address, err)
		if errors.Is(err, unix.EACCES) {
			message = fmt.Sprintf("port %d needs root in the imp; pick a port above 1023", port)
		}
		return -1, &proto.Error{Code: proto.ErrListenFailed, Message: message}
	}
	return sock, nil
}

// bindUnix binds path's name in its directory. The directory is opened
// first and resolved, so a symlink cannot lead under /run/imp, and a socket
// left at the name (a forward that ended with a forced sleep) is replaced,
// as OpenSSH's StreamLocalBindUnlink does; anything else there is refused.
func bindUnix(address string) ([]int, error) {
	clean := filepath.Clean(address)
	dirPath, name := filepath.Dir(clean), filepath.Base(clean)
	dir, err := unix.Open(dirPath, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("the directory %s does not exist in the imp", dirPath)}
	}
	if err != nil {
		return nil, &proto.Error{Code: proto.ErrListenFailed, Message: fmt.Sprintf("open %s: %v", dirPath, err)}
	}
	sock := -1
	fail := func(code, message string) ([]int, error) {
		unix.Close(dir)
		if sock >= 0 {
			unix.Close(sock)
		}
		return nil, &proto.Error{Code: code, Message: message}
	}

	procDir := fmt.Sprintf("/proc/self/fd/%d", dir)
	real, err := os.Readlink(procDir)
	if err != nil {
		return fail(proto.ErrListenFailed, err.Error())
	}
	if real == impDir || strings.HasPrefix(real, impDir+"/") {
		return fail(proto.ErrBadRequest, address+" leads to the agent's own sockets")
	}

	var st unix.Stat_t
	err = unix.Fstatat(dir, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	switch {
	case err == nil && st.Mode&unix.S_IFMT == unix.S_IFSOCK:
		if err := unix.Unlinkat(dir, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return fail(proto.ErrListenFailed, fmt.Sprintf("remove the old socket %s: %v", address, err))
		}
	case err == nil:
		return fail(proto.ErrListenFailed, address+" exists and is not a socket")
	case !errors.Is(err, unix.ENOENT):
		return fail(proto.ErrListenFailed, fmt.Sprintf("stat %s: %v", address, err))
	}

	if sock, err = unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0); err != nil {
		return fail(proto.ErrListenFailed, "socket: "+err.Error())
	}
	// Through the open directory: the path the check resolved is the one
	// bound. A fresh socket's mode follows the umask; the chmod narrows it.
	bindPath := procDir + "/" + name
	if err := unix.Bind(sock, &unix.SockaddrUnix{Name: bindPath}); err != nil {
		return fail(proto.ErrListenFailed, fmt.Sprintf("bind %s: %v", address, err))
	}
	if err := unix.Fchmodat(dir, name, 0o600, 0); err != nil {
		unix.Unlinkat(dir, name, 0)
		return fail(proto.ErrListenFailed, fmt.Sprintf("chmod %s: %v", address, err))
	}
	if err := unix.Listen(sock, listenBacklog); err != nil {
		unix.Unlinkat(dir, name, 0)
		return fail(proto.ErrListenFailed, fmt.Sprintf("listen on %s: %v", address, err))
	}
	return []int{sock, dir}, nil
}

// RunListenHelper is `imp-agent listen-as-user <network> <address>`: it
// binds as this process's user and answers on fd 0 with the listening
// socket (and its directory), or the error.
func RunListenHelper(network, address string) error {
	if err := checkListenAddress(network, address); err != nil {
		return answer(nil, err)
	}
	return answer(bindSocket(network, address))
}
