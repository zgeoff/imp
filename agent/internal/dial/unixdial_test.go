package dial

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

var testReaper *reaper.Reaper

// The test binary is also the dial and listen helper: the Dialer starts
// os.Args[0] with `dial-unix <path>` or `listen-as-user <network>
// <address>`. A few dial paths make a helper that misbehaves.
func TestMain(m *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == HelperCommand {
		runTestHelper(os.Args[2])
		return
	}
	if len(os.Args) == 4 && os.Args[1] == ListenCommand {
		if err := RunListenHelper(os.Args[2], os.Args[3]); err != nil {
			os.Exit(1)
		}
		return
	}
	testReaper = reaper.New()
	os.Exit(m.Run())
}

func runTestHelper(address string) {
	switch address {
	case "/hang":
		time.Sleep(time.Hour)
	case "/die":
		os.Exit(3)
	case "/junk":
		unix.Sendmsg(0, []byte{answerOK}, nil, nil, 0)
	case "/datagram":
		fd, _ := unix.Socket(unix.AF_UNIX, unix.SOCK_DGRAM, 0)
		unix.Sendmsg(0, []byte{answerOK}, unix.UnixRights(fd), nil, 0)
	case "/fds":
		out, _ := os.Readlink("/proc/self/fd/1")
		errOut, _ := os.Readlink("/proc/self/fd/2")
		unix.Sendmsg(0, []byte(string(answerFailed)+out+","+errOut), nil, nil, 0)
	case "/two":
		pair, _ := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
		unix.Sendmsg(0, []byte{answerOK}, unix.UnixRights(pair[0], pair[1]), nil, 0)
	default:
		if err := RunHelper(address); err != nil {
			os.Exit(1)
		}
	}
}

// testDialer dials unix sockets as user; "" is root, which connects in the
// agent itself
func testDialer(user string) *Dialer {
	return NewDialer(&proc.Direct{Reaper: testReaper, Agent: os.Args[0]}, imagecfg.NewLive(imagecfg.Config{User: user}))
}

// listenUnix serves an echo on a socket in dir and returns its absolute
// path. It binds a relative path: a unix socket path has a 108-byte limit,
// which the dial, through /proc/self/fd, does not have.
func listenUnix(t *testing.T, dir, name string) string {
	t.Helper()
	t.Chdir(dir)
	l, err := net.Listen("unix", name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				io.Copy(c, c)
			}()
		}
	}()
	return filepath.Join(dir, name)
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}

func requireEcho(t *testing.T, c net.Conn) {
	t.Helper()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo: %q %v", buf, err)
	}
}

func countFds(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

func TestTheHelperConnectsAndHandsTheSocketBack(t *testing.T) {
	path := listenUnix(t, t.TempDir(), "echo.sock")

	c, err := testDialer("").openUnix(path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	requireEcho(t, c)
}

func TestARootImageDialsInTheAgent(t *testing.T) {
	path := listenUnix(t, t.TempDir(), "echo.sock")

	h := startServe(t, proto.Request{Op: proto.OpDial, Network: "unix", Address: path})
	h.requireOK(t)
}

func TestARelativePathOrAnAbstractSocketIsABadRequest(t *testing.T) {
	for _, address := range []string{"echo.sock", "@abstract"} {
		h := startServe(t, proto.Request{Op: proto.OpDial, Network: "unix", Address: address})
		h.requireError(t, proto.ErrBadRequest)
		h.waitServed(t)
	}
}

// A symlink to a socket under the agent's own directory is refused. The
// helper runs connectUnix, with the real impDir.
func TestSymlinkIntoImpDirIsRefused(t *testing.T) {
	dir := t.TempDir()
	old := impDir
	impDir = filepath.Join(dir, "imp")
	t.Cleanup(func() { impDir = old })
	if err := os.MkdirAll(impDir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := listenUnix(t, impDir, "agent.sock")
	link := filepath.Join(dir, "link.sock")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	_, err := connectUnix(link)
	requireCode(t, err, proto.ErrBadRequest)
}

// A helper that hangs is killed at the deadline; one that dies, answers
// without a socket, or with a datagram socket fails the dial.
func TestAHelperThatMisbehavesFailsTheDial(t *testing.T) {
	old := helperTimeout
	helperTimeout = 300 * time.Millisecond
	t.Cleanup(func() { helperTimeout = old })

	for _, address := range []string{"/hang", "/die", "/junk", "/datagram", "/no/such.sock"} {
		started := time.Now()
		_, err := testDialer("").openUnix(address)
		requireCode(t, err, proto.ErrDialFailed)
		if time.Since(started) > 2*time.Second {
			t.Fatalf("%s took %s", address, time.Since(started))
		}
	}
}

// The helper's stdout and stderr are /dev/null, so its own fds land above 2
// and a runtime crash message never goes into the target socket.
func TestTheHelperWritesNothingIntoTheSocket(t *testing.T) {
	_, err := testDialer("").openUnix("/fds")

	requireCode(t, err, proto.ErrDialFailed)
	if !strings.Contains(err.Error(), "/dev/null,/dev/null") {
		t.Fatalf("the helper's fds 1 and 2: %v", err)
	}
}

// Fds past the first in the helper's message are closed, not leaked.
func TestExtraFdsInTheAnswerAreClosed(t *testing.T) {
	before := countFds(t)

	c, err := testDialer("").openUnix("/two")
	if err != nil {
		t.Fatal(err)
	}
	c.Close()

	if after := countFds(t); after != before {
		t.Fatalf("%d fds open after the dial, %d before", after, before)
	}
}

// A received fd is close-on-exec from the recvmsg on, so a child that an
// exec forks meanwhile does not inherit it.
func TestTheReceivedFdIsCloseOnExec(t *testing.T) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(pair[0])
	defer unix.Close(pair[1])
	sent, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(sent)
	if err := unix.Sendmsg(pair[1], []byte{answerOK}, unix.UnixRights(sent), nil, 0); err != nil {
		t.Fatal(err)
	}

	fd, err := receiveSocket(pair[0], time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil || flags&unix.FD_CLOEXEC == 0 {
		t.Fatalf("fd flags %d %v, want FD_CLOEXEC", flags, err)
	}

	out := listChildFds(t)
	for _, name := range strings.Fields(string(out)) {
		if name == fmt.Sprint(fd) {
			t.Fatalf("a child inherited fd %d", fd)
		}
	}
}

// As root: the helper takes the user's uid, gid and supplementary groups,
// and the server sees the user in SO_PEERCRED.
func TestAUnixDialRunsAsTheUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to change credentials")
	}
	const uid, gid, docker = 4242, 4242, 4343
	dir, err := os.MkdirTemp("/tmp", "dial")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	hidden := filepath.Join(dir, "hidden")
	if err := os.Mkdir(hidden, 0o700); err != nil {
		t.Fatal(err)
	}

	own := listenPeer(t, dir, "own.sock", uid, gid, 0o600)
	group := listenPeer(t, dir, "docker.sock", 0, docker, 0o660)
	rootOnly := listenPeer(t, dir, "root.sock", 0, 0, 0o600)
	inHidden := listenPeer(t, hidden, "open.sock", 0, 0, 0o666)

	// the user cannot run the test binary where go test built it
	helper := filepath.Join(dir, "helper")
	binary, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, binary, 0o755); err != nil {
		t.Fatal(err)
	}

	d := NewDialer(&proc.Direct{Reaper: testReaper, Agent: helper}, imagecfg.NewLive(imagecfg.Config{User: "dev"}))
	d.cred = &syscall.Credential{Uid: uid, Gid: gid, Groups: []uint32{docker}}

	for _, ok := range []*peerListener{own, group} {
		c, err := d.openUnix(ok.path)
		if err != nil {
			t.Fatalf("%s: %v", ok.path, err)
		}
		c.Close()
		if got := <-ok.peerUID; got != uid {
			t.Fatalf("%s: the server saw uid %d, want %d", ok.path, got, uid)
		}
	}
	for _, refused := range []*peerListener{rootOnly, inHidden} {
		_, err := d.openUnix(refused.path)
		requireCode(t, err, proto.ErrDialFailed)
	}
}

type peerListener struct {
	path    string
	peerUID chan uint32
}

// listenPeer listens on dir/name, owned by uid:gid with mode, and reports
// the uid of each client from SO_PEERCRED.
func listenPeer(t *testing.T, dir, name string, uid, gid int, mode os.FileMode) *peerListener {
	t.Helper()
	path := filepath.Join(dir, name)
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	if err := os.Chown(path, uid, gid); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	p := &peerListener{path: path, peerUID: make(chan uint32, 1)}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			raw, _ := c.(*net.UnixConn).SyscallConn()
			raw.Control(func(fd uintptr) {
				cred, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
				if err == nil {
					p.peerUID <- cred.Uid
				}
			})
			c.Close()
		}
	}()
	return p
}

// listChildFds forks /bin/sh to list its own fds. It forks through the test
// reaper, which reaps every child: os/exec's Wait would race it.
func listChildFds(t *testing.T) []byte {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	attr := &syscall.ProcAttr{Files: []uintptr{0, w.Fd(), 2}}
	_, done, err := testReaper.Start(func() (int, error) {
		return syscall.ForkExec("/bin/sh", []string{"sh", "-c", "ls /proc/self/fd"}, attr)
	})
	w.Close()
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	<-done
	return out
}
