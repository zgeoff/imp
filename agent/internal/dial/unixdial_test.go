package dial

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

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

// runTestHelper is the dial helper for address. A few addresses name a
// fault instead, each a helper that misbehaves in one way; the tests of the
// faults pin what each sends.
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

// startFaultyHelper runs the test binary as the dial helper for fault, as
// the Dialer runs the agent: its end of a socketpair as fd 0, /dev/null as
// fds 1 and 2, and an empty env. It returns the helper's exit, which comes
// once, and the other end.
func startFaultyHelper(t *testing.T, fault string) (<-chan reaper.Status, int) {
	t.Helper()
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	assert.NilError(t, err)
	t.Cleanup(func() { unix.Close(pair[0]) })
	child := os.NewFile(uintptr(pair[1]), "the helper's end")
	devNull, err := os.Open(os.DevNull)
	assert.NilError(t, err)
	t.Cleanup(func() { devNull.Close() })
	p, err := (&proc.Direct{Reaper: testReaper, Agent: os.Args[0]}).Start(proc.Spec{
		Argv:   []string{"imp-agent", HelperCommand, fault},
		Env:    []string{},
		Dir:    "/",
		Helper: true,
		Files:  []*os.File{child, devNull, devNull},
	})
	child.Close()
	assert.NilError(t, err)
	exit, gone := make(chan reaper.Status, 1), make(chan struct{})
	go func() {
		defer close(gone)
		exit <- <-p.Done
	}()
	t.Cleanup(func() {
		p.Kill()
		<-gone
	})
	return exit, pair[0]
}

// helperAnswer is what a helper sent in one message: its bytes, and the
// socket type of each fd it passed.
type helperAnswer struct {
	Payload string
	FdTypes []int
}

// readHelperAnswer reads one message from conn, waiting up to wait for it,
// and closes the fds it carried.
func readHelperAnswer(t *testing.T, conn int, wait time.Duration) (helperAnswer, error) {
	t.Helper()
	tv := unix.NsecToTimeval(wait.Nanoseconds())
	assert.NilError(t, unix.SetsockoptTimeval(conn, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv))
	buf := make([]byte, 4096)
	oob := make([]byte, unix.CmsgSpace(4*4))
	// a socket with a receive timeout is not restarted after a signal, such
	// as the reaper's SIGCHLD
	n, oobn, _, _, err := unix.Recvmsg(conn, buf, oob, unix.MSG_CMSG_CLOEXEC)
	for errors.Is(err, unix.EINTR) {
		n, oobn, _, _, err = unix.Recvmsg(conn, buf, oob, unix.MSG_CMSG_CLOEXEC)
	}
	if err != nil {
		return helperAnswer{}, err
	}
	msgs, err := unix.ParseSocketControlMessage(oob[:oobn])
	assert.NilError(t, err)
	answer := helperAnswer{Payload: string(buf[:n])}
	for _, m := range msgs {
		fds, err := unix.ParseUnixRights(&m)
		assert.NilError(t, err)
		for _, fd := range fds {
			typ, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_TYPE)
			assert.NilError(t, err)
			answer.FdTypes = append(answer.FdTypes, typ)
			unix.Close(fd)
		}
	}
	return answer, nil
}

func TestTheFaultyHelpersSendWhatTheirFaultNames(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		fault  string
		answer helperAnswer
		exit   int
	}{
		// an exit with no answer reads as the end of the stream
		{fault: "/die", answer: helperAnswer{}, exit: 3},
		{fault: "/junk", answer: helperAnswer{Payload: "k"}, exit: 0},
		{fault: "/datagram", answer: helperAnswer{Payload: "k", FdTypes: []int{unix.SOCK_DGRAM}}, exit: 0},
		{fault: "/fds", answer: helperAnswer{Payload: "d/dev/null,/dev/null"}, exit: 0},
		{fault: "/two", answer: helperAnswer{Payload: "k", FdTypes: []int{unix.SOCK_STREAM, unix.SOCK_STREAM}}, exit: 0},
	} {
		t.Run(tc.fault, func(t *testing.T) {
			t.Parallel()
			exit, conn := startFaultyHelper(t, tc.fault)

			answer, err := readHelperAnswer(t, conn, 5*time.Second)
			var st reaper.Status
			select {
			case st = <-exit:
			case <-time.After(5 * time.Second):
				t.Fatal("the helper did not exit")
			}

			assert.NilError(t, err)
			assert.Check(t, cmp.DeepEqual(answer, tc.answer))
			assert.Check(t, cmp.Equal(st.Code, tc.exit))
		})
	}
}

// A hung helper neither answers nor exits: an exit would end the stream, and
// the read would return no bytes instead of timing out.
func TestTheHangingHelperNeverAnswers(t *testing.T) {
	t.Parallel()
	_, conn := startFaultyHelper(t, "/hang")

	_, err := readHelperAnswer(t, conn, 200*time.Millisecond)

	assert.Check(t, cmp.ErrorIs(err, unix.EAGAIN))
}

// testDialer dials unix sockets as user; "" is root, which connects in the
// agent itself
func testDialer(user string) *Dialer {
	return NewDialer(&proc.Direct{Reaper: testReaper, Agent: os.Args[0]}, imagecfg.NewLive(imagecfg.Config{User: user}))
}

// shortDir makes a directory of the test's own with a short path: a unix
// socket path has a 108-byte limit, which a t.TempDir under a long TMPDIR
// can pass.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "dial")
	assert.NilError(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// listenUnix serves an echo on dir/name and returns its path.
func listenUnix(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	l, err := net.Listen("unix", path)
	assert.NilError(t, err)
	serveConns(t, l, func(c net.Conn) { io.Copy(c, c) })
	return path
}

// codeOf returns the protocol error code that err carries.
func codeOf(t *testing.T, err error) string {
	t.Helper()
	var pe *proto.Error
	assert.Assert(t, errors.As(err, &pe), "got %v, want a protocol error", err)
	return pe.Code
}

// echo writes ping to c and returns what comes back.
func echo(t *testing.T, c net.Conn) string {
	t.Helper()
	assert.NilError(t, c.SetDeadline(time.Now().Add(5*time.Second)))
	_, err := c.Write([]byte("ping"))
	assert.NilError(t, err)
	buf := make([]byte, 4)
	_, err = io.ReadFull(c, buf)
	assert.NilError(t, err)
	return string(buf)
}

func countFds(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	assert.NilError(t, err)
	return len(entries)
}

func TestOpenUnixConnectsThroughTheHelperAndHandsTheSocketBack(t *testing.T) {
	t.Parallel()
	path := listenUnix(t, shortDir(t), "echo.sock")

	c, err := testDialer("").openUnix(path)

	assert.NilError(t, err)
	t.Cleanup(func() { c.Close() })
	assert.Check(t, cmp.Equal(echo(t, c), "ping"))
}

func TestServeDialsAUnixSocketForARootImageInTheAgent(t *testing.T) {
	t.Parallel()
	path := listenUnix(t, shortDir(t), "echo.sock")

	h := startServe(t, proto.Request{Op: proto.OpDial, Network: "unix", Address: path})

	h.requireOK(t)
}

// A symlink to a socket under the agent's own directory is refused. The
// helper runs connectUnix, with the real impDir.
func TestConnectUnixRefusesASymlinkIntoTheAgentsDirectory(t *testing.T) {
	dir := shortDir(t)
	old := impDir
	impDir = filepath.Join(dir, "imp")
	t.Cleanup(func() { impDir = old })
	assert.NilError(t, os.MkdirAll(impDir, 0o700))
	target := listenUnix(t, impDir, "agent.sock")
	link := filepath.Join(dir, "link.sock")
	assert.NilError(t, os.Symlink(target, link))

	_, err := connectUnix(link)

	assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrBadRequest))
}

// A helper that hangs is killed at the deadline; one that dies, answers
// without a socket, or with a datagram socket fails the dial.
func TestOpenUnixFailsTheDialWhenTheHelperMisbehaves(t *testing.T) {
	old := helperTimeout
	helperTimeout = 300 * time.Millisecond
	t.Cleanup(func() { helperTimeout = old })
	for _, address := range []string{"/hang", "/die", "/junk", "/datagram", "/no/such.sock"} {
		t.Run(address, func(t *testing.T) {
			started := time.Now()

			_, err := testDialer("").openUnix(address)
			took := time.Since(started)

			assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrDialFailed))
			assert.Check(t, took <= 2*time.Second, "took %s", took)
		})
	}
}

// The helper's stdout and stderr are /dev/null, so its own fds land above 2
// and a runtime crash message never goes into the target socket.
func TestOpenUnixGivesTheHelperDevNullForStdoutAndStderr(t *testing.T) {
	t.Parallel()

	_, err := testDialer("").openUnix("/fds")

	assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrDialFailed))
	assert.Check(t, cmp.ErrorContains(err, "/dev/null,/dev/null"))
}

// Fds past the first in the helper's message are closed, not leaked.
func TestOpenUnixClosesExtraFdsInTheHelpersAnswer(t *testing.T) {
	before := countFds(t)

	c, err := testDialer("").openUnix("/two")
	assert.NilError(t, err)
	assert.NilError(t, c.Close())

	assert.Check(t, cmp.Equal(countFds(t), before))
}

// A received fd is close-on-exec from the recvmsg on, so a child that an
// exec forks meanwhile does not inherit it.
func TestReceiveSocketMarksTheFdCloseOnExec(t *testing.T) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	assert.NilError(t, err)
	t.Cleanup(func() { unix.Close(pair[0]); unix.Close(pair[1]) })
	sent, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	assert.NilError(t, err)
	t.Cleanup(func() { unix.Close(sent) })
	assert.NilError(t, unix.Sendmsg(pair[1], []byte{answerOK}, unix.UnixRights(sent), nil, 0))

	fd, err := receiveSocket(pair[0], time.Second)
	assert.NilError(t, err)
	t.Cleanup(func() { unix.Close(fd) })

	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	assert.NilError(t, err)
	assert.Check(t, flags&unix.FD_CLOEXEC != 0, "fd flags %d, want FD_CLOEXEC", flags)
	inherited := strings.Fields(string(listChildFds(t)))
	assert.Check(t, !slices.Contains(inherited, fmt.Sprint(fd)), "a child inherited fd %d", fd)
}

// The uid, gid and supplementary group the user's helper runs with, as
// root sets them.
const userUID, userGID, dockerGID = 4242, 4242, 4343

// userDialer dials as the user, through a copy of the helper in dir.
func userDialer(t *testing.T, dir string) *Dialer {
	t.Helper()
	d := NewDialer(&proc.Direct{Reaper: testReaper, Agent: helperCopy(t, dir)}, imagecfg.NewLive(imagecfg.Config{User: "dev"}))
	d.cred = &syscall.Credential{Uid: userUID, Gid: userGID, Groups: []uint32{dockerGID}}
	return d
}

// As root: the helper takes the user's uid, gid and supplementary groups,
// and the server sees the user in SO_PEERCRED.
func TestOpenUnixConnectsAsTheUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to change credentials")
	}
	for _, tc := range []struct {
		name     string
		uid, gid int
		mode     os.FileMode
	}{
		{name: "the user's own socket", uid: userUID, gid: userGID, mode: 0o600},
		{name: "a socket of a supplementary group", uid: 0, gid: dockerGID, mode: 0o660},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := shortDir(t)
			assert.NilError(t, os.Chmod(dir, 0o755))
			peer := listenPeer(t, dir, "target.sock", tc.uid, tc.gid, tc.mode)
			d := userDialer(t, dir)

			c, err := d.openUnix(peer.path)

			assert.NilError(t, err)
			assert.NilError(t, c.Close())
			assert.Check(t, cmp.Equal(<-peer.peerUID, uint32(userUID)), "the uid the server saw")
		})
	}
}

// As root: the helper connects with the user's rights, so a socket the user
// cannot reach fails the dial.
func TestOpenUnixRefusesASocketTheUserCannotReach(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to change credentials")
	}
	for _, tc := range []struct {
		name string
		// socket makes the target under dir and returns its path
		socket func(t *testing.T, dir string) string
	}{
		{name: "a socket only root may use", socket: func(t *testing.T, dir string) string {
			return listenPeer(t, dir, "root.sock", 0, 0, 0o600).path
		}},
		{name: "an open socket in a directory only root may enter", socket: func(t *testing.T, dir string) string {
			hidden := filepath.Join(dir, "hidden")
			assert.NilError(t, os.Mkdir(hidden, 0o700))
			return listenPeer(t, hidden, "open.sock", 0, 0, 0o666).path
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := shortDir(t)
			assert.NilError(t, os.Chmod(dir, 0o755))
			path := tc.socket(t, dir)
			d := userDialer(t, dir)

			_, err := d.openUnix(path)

			assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrDialFailed))
		})
	}
}

// helperCopy copies the test binary, which is also the helper, into dir:
// the user cannot run it where go test built it.
func helperCopy(t *testing.T, dir string) string {
	t.Helper()
	helper := filepath.Join(dir, "helper")
	binary, err := os.ReadFile(os.Args[0])
	assert.NilError(t, err)
	assert.NilError(t, os.WriteFile(helper, binary, 0o755))
	return helper
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
	assert.NilError(t, err)
	stop := make(chan struct{})
	assert.NilError(t, os.Chown(path, uid, gid))
	assert.NilError(t, os.Chmod(path, mode))
	p := &peerListener{path: path, peerUID: make(chan uint32, 1)}
	serveConns(t, l, func(c net.Conn) {
		raw, err := c.(*net.UnixConn).SyscallConn()
		if err != nil {
			return
		}
		var uid uint32
		var credErr error
		raw.Control(func(fd uintptr) {
			var cred *unix.Ucred
			cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
			if credErr == nil {
				uid = cred.Uid
			}
		})
		if credErr != nil {
			return
		}
		select {
		case p.peerUID <- uid:
		case <-stop:
		}
	})
	// registered after serveConns, so it runs first and frees a handler
	// blocked on the report before serveConns waits for it
	t.Cleanup(func() { close(stop) })
	return p
}

// listChildFds forks /bin/sh to list its own fds. It forks through the test
// reaper, which reaps every child: os/exec's Wait would race it.
func listChildFds(t *testing.T) []byte {
	t.Helper()
	r, w, err := os.Pipe()
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })
	attr := &syscall.ProcAttr{Files: []uintptr{0, w.Fd(), 2}}
	_, done, err := testReaper.Start(func() (int, error) {
		return syscall.ForkExec("/bin/sh", []string{"sh", "-c", "ls /proc/self/fd"}, attr)
	})
	w.Close()
	assert.NilError(t, err)
	out, err := io.ReadAll(r)
	assert.NilError(t, err)
	<-done
	return out
}
