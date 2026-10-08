package listen

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/dial"
	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

// host is impd's end of one agent connection, with the manager serving the
// other end.
type host struct {
	conn   net.Conn
	r      *proto.Reader
	w      *proto.Writer
	served chan error
}

func startHost(t *testing.T, serve func(r *proto.Reader, w *proto.Writer) error) *host {
	t.Helper()
	hostEnd, guestEnd := net.Pipe()
	t.Cleanup(func() { hostEnd.Close() })
	assert.NilError(t, hostEnd.SetDeadline(time.Now().Add(5*time.Second)))
	h := &host{conn: hostEnd, r: proto.NewReader(hostEnd), w: proto.NewWriter(hostEnd), served: make(chan error, 1)}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		h.served <- serve(proto.NewReader(guestEnd), proto.NewWriter(guestEnd))
		guestEnd.Close()
	}()
	// registered after the close above, so it runs first: the close ends
	// Serve, and the test does not end before it returns
	t.Cleanup(func() {
		hostEnd.Close()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("Serve did not return after the host closed")
		}
	})
	return h
}

func (h *host) next(t *testing.T, want proto.Type, v any) {
	t.Helper()
	f, err := h.r.Next()
	assert.NilError(t, err, "read frame")
	assert.Equal(t, f.Type, want, "frame %s", f.Payload)
	if v != nil {
		assert.NilError(t, json.Unmarshal(f.Payload, v), "decode %s", f.Payload)
	}
}

// shortDir makes a directory of the test's own with a short path: a unix
// socket path has a 108-byte limit, which a t.TempDir under a long TMPDIR
// can pass.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "listen")
	assert.NilError(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// newManager serves sockets as the test's own user, under roots in dir.
func newManager(t *testing.T, dir string) *Manager {
	t.Helper()
	return NewManager(filepath.Join(dir, "agents"), filepath.Join(dir, "forwards"), imagecfg.NewLive(imagecfg.Config{User: fmt.Sprint(os.Getuid())}), testBinder(), fsroot.Host)
}

var testReaper *reaper.Reaper

// TestMain doubles as the listen helper, which the binder starts as this
// test binary.
func TestMain(m *testing.M) {
	if len(os.Args) == 4 && os.Args[1] == dial.ListenCommand {
		if err := dial.RunListenHelper(os.Args[2], os.Args[3]); err != nil {
			os.Exit(1)
		}
		return
	}
	testReaper = reaper.New()
	os.Exit(m.Run())
}

// testBinder binds through the helper, as the test's own user
func testBinder() Binder {
	return dial.NewDialer(&proc.Direct{Reaper: testReaper, Agent: os.Args[0]}, imagecfg.NewLive(imagecfg.Config{User: ""}))
}

func listen(t *testing.T, m *Manager) (*host, proto.Listening) {
	t.Helper()
	h := startHost(t, m.ServeAgent)
	var resp proto.Listening
	h.next(t, proto.TypeResponse, &resp)
	assert.Assert(t, resp.OK && resp.Listener != "", "listen: %+v", resp)
	return h, resp
}

func dialSocket(t *testing.T, path string) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", path)
	assert.NilError(t, err, "dial %s", path)
	t.Cleanup(func() { c.Close() })
	assert.NilError(t, c.SetDeadline(time.Now().Add(5*time.Second)))
	return c
}

// readEnd reads c until its first byte or error and returns the error: io.EOF
// when the agent closed it.
func readEnd(c net.Conn) error {
	_, err := c.Read(make([]byte, 1))
	return err
}

func TestServeAgentMakesTheSocketAndItsDirectoryTheUsersAlone(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))

	_, resp := listen(t, m)

	sock, err := os.Lstat(resp.Path)
	assert.NilError(t, err)
	dir, err := os.Lstat(filepath.Dir(resp.Path))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(sock.Mode().Perm(), os.FileMode(0o600)))
	assert.Check(t, cmp.Equal(dir.Mode().Perm(), os.FileMode(0o700)))
}

func TestAcceptRelaysTheClientAndTheHostBothWays(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	control, resp := listen(t, m)
	client := dialSocket(t, resp.Path)
	var conn proto.Connection
	control.next(t, proto.TypeConnection, &conn)
	relay := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Accept(proto.Request{Listener: resp.Listener, Connection: conn.ID}, r, w)
	})
	relay.next(t, proto.TypeResponse, nil)

	_, err := client.Write([]byte("request"))
	assert.NilError(t, err)
	f, err := relay.r.Next()
	assert.NilError(t, err)
	assert.NilError(t, relay.w.Write(proto.TypeStdin, []byte("answer")))
	buf := make([]byte, 6)
	_, err = io.ReadFull(client, buf)
	assert.NilError(t, err)

	assert.Check(t, cmp.Equal(f.Type, proto.TypeStdout))
	assert.Check(t, cmp.Equal(string(f.Payload), "request"))
	assert.Check(t, cmp.Equal(string(buf), "answer"))
}

func TestServeAgentRemovesTheSocketDirectoryWhenTheHostCloses(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	control, resp := listen(t, m)

	control.conn.Close()
	err := <-control.served

	assert.Check(t, err, "listen")
	_, err = os.Stat(filepath.Dir(resp.Path))
	assert.Check(t, cmp.ErrorIs(err, os.ErrNotExist))
}

// impd refuses a client when the user's ssh refuses the agent channel; the
// client must see the close at once, not after the pending timeout.
func TestAcceptClosesTheClientWhenTheHostEndsTheRelay(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	control, resp := listen(t, m)
	client := dialSocket(t, resp.Path)
	var conn proto.Connection
	control.next(t, proto.TypeConnection, &conn)
	relay := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Accept(proto.Request{Listener: resp.Listener, Connection: conn.ID}, r, w)
	})
	relay.next(t, proto.TypeResponse, nil)

	relay.conn.Close()

	assert.Check(t, cmp.ErrorIs(readEnd(client), io.EOF))
}

func TestAcceptRefusesAnUnknownConnection(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	_, resp := listen(t, m)

	relay := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Accept(proto.Request{Listener: resp.Listener, Connection: 99}, r, w)
	})

	var got proto.ErrorResponse
	relay.next(t, proto.TypeResponse, &got)
	assert.Assert(t, got.Error != nil, "got %+v, want an error", got)
	assert.Check(t, cmp.Equal(got.Error.Code, proto.ErrNoConnection))
}

func TestServeAgentNumbersWaitingClientsAndClosesThoseOverTheCap(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	control, resp := listen(t, m)

	var ids, want []uint64
	for i := range 16 {
		dialSocket(t, resp.Path)
		var conn proto.Connection
		control.next(t, proto.TypeConnection, &conn)
		ids = append(ids, conn.ID)
		want = append(want, uint64(i+1))
	}
	over := dialSocket(t, resp.Path)

	assert.Check(t, cmp.DeepEqual(ids, want))
	assert.Check(t, cmp.ErrorIs(readEnd(over), io.EOF))
}

func TestServeAgentClosesAClientTheHostNeverPairs(t *testing.T) {
	old := pendingTimeout
	pendingTimeout = 50 * time.Millisecond
	t.Cleanup(func() { pendingTimeout = old })
	m := newManager(t, shortDir(t))
	control, resp := listen(t, m)

	client := dialSocket(t, resp.Path)
	control.next(t, proto.TypeConnection, nil)

	assert.Check(t, cmp.ErrorIs(readEnd(client), io.EOF))
}

func TestAllowsOnlyTheSocketsOwner(t *testing.T) {
	t.Parallel()
	if os.Getuid() == 0 {
		t.Skip("root is always allowed")
	}
	path := filepath.Join(shortDir(t), "s")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	assert.NilError(t, err)
	t.Cleanup(func() { ln.Close() })
	dialSocket(t, path)
	c, err := ln.AcceptUnix()
	assert.NilError(t, err)
	t.Cleanup(func() { c.Close() })

	owner := &listener{uid: uint32(os.Getuid())}
	other := &listener{uid: 65534}

	assert.Check(t, owner.allows(c), "the owner is refused")
	assert.Check(t, !other.allows(c), "another user is allowed")
}

func TestServeAgentRefusesAnUnknownUserAndLeavesNoDirectory(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	m := NewManager(filepath.Join(dir, "agents"), filepath.Join(dir, "forwards"), imagecfg.NewLive(imagecfg.Config{User: "no-such-user"}), testBinder(), fsroot.Host)

	h := startHost(t, m.ServeAgent)

	var got proto.ErrorResponse
	h.next(t, proto.TypeResponse, &got)
	assert.Check(t, got.Error != nil, "got %+v, want an error", got)
	entries, err := os.ReadDir(filepath.Join(dir, "agents"))
	if !errors.Is(err, os.ErrNotExist) {
		assert.NilError(t, err)
	}
	assert.Check(t, cmp.Len(entries, 0))
}

// serveListen starts a listen connection and reads its answer.
func serveListen(t *testing.T, m *Manager, network, address string) (*host, proto.Listening, *proto.Error) {
	t.Helper()
	h := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Serve(proto.Request{Network: network, Address: address}, r, w)
	})
	f, err := h.r.Next()
	assert.NilError(t, err, "listen answer")
	assert.Equal(t, f.Type, proto.TypeResponse, "listen answer %s", f.Payload)
	var failed proto.ErrorResponse
	if json.Unmarshal(f.Payload, &failed) == nil && failed.Error != nil {
		return h, proto.Listening{}, failed.Error
	}
	var resp proto.Listening
	assert.NilError(t, json.Unmarshal(f.Payload, &resp), "listen: %s", f.Payload)
	assert.Assert(t, resp.OK && resp.Listener != "", "listen: %s", f.Payload)
	return h, resp, nil
}

func requireListening(t *testing.T, m *Manager, network, address string) (*host, proto.Listening) {
	t.Helper()
	h, resp, failed := serveListen(t, m, network, address)
	assert.Assert(t, failed == nil, "listen %s %s: %v", network, address, failed)
	return h, resp
}

func refusal(t *testing.T, m *Manager, network, address string) string {
	t.Helper()
	_, _, failed := serveListen(t, m, network, address)
	assert.Assert(t, failed != nil, "listen %s %q was not refused", network, address)
	return failed.Code
}

// relayOnce pairs the next client with an accept and returns what the host
// read of the client's "ping".
func relayOnce(t *testing.T, m *Manager, control *host, listener string, client net.Conn) proto.Frame {
	t.Helper()
	var conn proto.Connection
	control.next(t, proto.TypeConnection, &conn)
	relay := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Accept(proto.Request{Listener: listener, Connection: conn.ID}, r, w)
	})
	relay.next(t, proto.TypeResponse, nil)
	_, err := client.Write([]byte("ping"))
	assert.NilError(t, err)
	f, err := relay.r.Next()
	assert.NilError(t, err)
	return f
}

func endListener(t *testing.T, control *host) error {
	t.Helper()
	control.conn.Close()
	return <-control.served
}

func TestServeGivesAForwardWithNoPathASocketOfItsOwn(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))

	_, resp := requireListening(t, m, "unix", "")

	assert.Check(t, cmp.Equal(filepath.Base(filepath.Dir(filepath.Dir(resp.Path))), "forwards"), "path %s is not under the forward root", resp.Path)
	sock, err := os.Lstat(resp.Path)
	assert.NilError(t, err)
	dir, err := os.Lstat(filepath.Dir(resp.Path))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(sock.Mode().Perm(), os.FileMode(0o600)))
	assert.Check(t, cmp.Equal(dir.Mode().Perm(), os.FileMode(0o700)))
}

func TestServeRelaysAClientOfAForwardWithNoPath(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	control, resp := requireListening(t, m, "unix", "")

	f := relayOnce(t, m, control, resp.Listener, dialSocket(t, resp.Path))

	assert.Check(t, cmp.Equal(f.Type, proto.TypeStdout))
	assert.Check(t, cmp.Equal(string(f.Payload), "ping"))
}

func TestServeRemovesAForwardsOwnSocketDirectoryWhenTheHostCloses(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	control, resp := requireListening(t, m, "unix", "")

	err := endListener(t, control)

	assert.Check(t, err, "listen")
	_, err = os.Stat(filepath.Dir(resp.Path))
	assert.Check(t, cmp.ErrorIs(err, os.ErrNotExist))
}

func TestServeBindsAClientPathAsTheUsersSocket(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	m := newManager(t, dir)
	path := filepath.Join(dir, "app.sock")

	_, resp := requireListening(t, m, "unix", path)

	assert.Check(t, cmp.Equal(resp.Path, path))
	info, err := os.Lstat(path)
	assert.NilError(t, err)
	assert.Check(t, info.Mode()&os.ModeSocket != 0, "mode %s is no socket", info.Mode())
	assert.Check(t, cmp.Equal(info.Mode().Perm(), os.FileMode(0o600)))
}

func TestServeRelaysAClientOfAClientPath(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	m := newManager(t, dir)
	path := filepath.Join(dir, "app.sock")
	control, resp := requireListening(t, m, "unix", path)

	f := relayOnce(t, m, control, resp.Listener, dialSocket(t, path))

	assert.Check(t, cmp.Equal(f.Type, proto.TypeStdout))
	assert.Check(t, cmp.Equal(string(f.Payload), "ping"))
}

func TestServeRemovesAClientPathSocketWhenTheHostCloses(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	m := newManager(t, dir)
	path := filepath.Join(dir, "app.sock")
	control, _ := requireListening(t, m, "unix", path)

	err := endListener(t, control)

	assert.Check(t, err, "listen")
	_, err = os.Lstat(path)
	assert.Check(t, cmp.ErrorIs(err, os.ErrNotExist))
}

// A forward that ended with a forced sleep leaves its socket; the next
// listen on the path replaces it.
func TestServeReplacesAStaleSocketAtTheClientPath(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	m := newManager(t, dir)
	path := filepath.Join(dir, "app.sock")
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	assert.NilError(t, err)
	stale.SetUnlinkOnClose(false)
	assert.NilError(t, stale.Close())

	control, _ := requireListening(t, m, "unix", path)
	dialSocket(t, path)

	control.next(t, proto.TypeConnection, nil)
}

func TestServeRefusesAndKeepsAFileThatIsNotASocket(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	m := newManager(t, dir)
	path := filepath.Join(dir, "notes")
	assert.NilError(t, os.WriteFile(path, []byte("keep"), 0o600))

	code := refusal(t, m, "unix", path)

	assert.Check(t, cmp.Equal(code, proto.ErrListenFailed))
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "keep"))
}

func TestServeRefusesABadListenRequest(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		network string
		address func(t *testing.T) string
	}{
		{name: "a missing directory", network: "unix", address: func(t *testing.T) string { return filepath.Join(t.TempDir(), "no", "such", "app.sock") }},
		{name: "a relative path", network: "unix", address: func(*testing.T) string { return "relative.sock" }},
		{name: "every interface", network: "tcp", address: func(*testing.T) string { return "0.0.0.0:0" }},
		{name: "a port out of range", network: "tcp", address: func(*testing.T) string { return "127.0.0.1:70000" }},
		{name: "udp", network: "udp", address: func(*testing.T) string { return "127.0.0.1:0" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			m := newManager(t, shortDir(t))

			code := refusal(t, m, tc.network, tc.address(t))

			assert.Check(t, cmp.Equal(code, proto.ErrBadRequest))
		})
	}
}

// The listener removes its own socket and nothing a process put at the name
// meanwhile.
func TestServeLeavesAnotherSocketAtThePathAloneWhenTheHostCloses(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	m := newManager(t, dir)
	path := filepath.Join(dir, "app.sock")
	control, _ := requireListening(t, m, "unix", path)
	assert.NilError(t, os.Remove(path))
	other, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	assert.NilError(t, err)
	t.Cleanup(func() { other.Close() })

	err = endListener(t, control)

	assert.Check(t, err, "listen")
	_, err = os.Lstat(path)
	assert.Check(t, err, "the other socket went")
}

func TestServeListensOnALoopbackTCPPort(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))

	_, resp := requireListening(t, m, "tcp", "127.0.0.1:0")

	assert.Check(t, resp.Port != 0, "got %+v, want a port", resp)
	assert.Check(t, cmp.Equal(resp.Path, ""))
}

func TestServeRelaysAClientOfALoopbackTCPPort(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	control, resp := requireListening(t, m, "tcp", "127.0.0.1:0")
	client, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", resp.Port))
	assert.NilError(t, err)
	t.Cleanup(func() { client.Close() })
	assert.NilError(t, client.SetDeadline(time.Now().Add(5*time.Second)))

	f := relayOnce(t, m, control, resp.Listener, client)

	assert.Check(t, cmp.Equal(f.Type, proto.TypeStdout))
	assert.Check(t, cmp.Equal(string(f.Payload), "ping"))
}

func TestServeClosesTheLoopbackTCPPortWhenTheHostCloses(t *testing.T) {
	t.Parallel()
	m := newManager(t, shortDir(t))
	control, resp := requireListening(t, m, "tcp", "127.0.0.1:0")

	err := endListener(t, control)

	assert.Check(t, err, "listen")
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", resp.Port))
	if err == nil {
		c.Close()
	}
	assert.Check(t, err != nil, "the port still listens")
}

// A socket's directory is judged by where it is, not by its path: a link
// such as Debian's /var/run -> /run leads onto a tmpfs.
func TestOnTmpfsJudgesADirectoryByWhereItIs(t *testing.T) {
	t.Parallel()
	// /dev/shm is the tmpfs the system provides; a fresh directory in it is
	// this test's own.
	tmpfs, err := os.MkdirTemp("/dev/shm", "imp-listen-")
	if err != nil {
		t.Skip("no tmpfs at /dev/shm:", err)
	}
	t.Cleanup(func() { os.RemoveAll(tmpfs) })
	disk := t.TempDir()
	if onDir(t, disk) {
		t.Skip("the test's temp dir is itself on a tmpfs")
	}
	varRun := filepath.Join(disk, "var-run")
	assert.NilError(t, os.Symlink(tmpfs, varRun))

	assert.Check(t, onDir(t, tmpfs), "the tmpfs directory")
	assert.Check(t, onDir(t, varRun), "a link onto the tmpfs")
	assert.Check(t, !onDir(t, disk), "the disk directory")
}

func onDir(t *testing.T, dir string) bool {
	t.Helper()
	d, err := os.Open(dir)
	assert.NilError(t, err)
	t.Cleanup(func() { d.Close() })
	return onTmpfs(int(d.Fd()))
}
