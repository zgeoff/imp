package listen

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/dial"
	"github.com/zgeoff/imp/agent/internal/fsroot"
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
	h := &host{conn: hostEnd, r: proto.NewReader(hostEnd), w: proto.NewWriter(hostEnd), served: make(chan error, 1)}
	go func() {
		h.served <- serve(proto.NewReader(guestEnd), proto.NewWriter(guestEnd))
		guestEnd.Close()
	}()
	t.Cleanup(func() { hostEnd.Close() })
	hostEnd.SetDeadline(time.Now().Add(5 * time.Second))
	return h
}

func (h *host) next(t *testing.T, want proto.Type, v any) {
	t.Helper()
	f, err := h.r.Next()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	if f.Type != want {
		t.Fatalf("got %s %s, want %s", f.Type, f.Payload, want)
	}
	if v != nil {
		if err := json.Unmarshal(f.Payload, v); err != nil {
			t.Fatalf("decode %s: %v", f.Payload, err)
		}
	}
}

// newManager serves sockets as the test's own user, under a short relative
// root: a unix socket path has a 108-byte limit.
func newManager(t *testing.T) *Manager {
	t.Helper()
	t.Chdir(t.TempDir())
	return NewManager("agents", "forwards", fmt.Sprint(os.Getuid()), testBinder(), fsroot.Host)
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
	return dial.NewDialer(&proc.Direct{Reaper: testReaper, Agent: os.Args[0]}, "")
}

func listen(t *testing.T, m *Manager) (*host, proto.Listening) {
	t.Helper()
	h := startHost(t, m.ServeAgent)
	var resp proto.Listening
	h.next(t, proto.TypeResponse, &resp)
	if !resp.OK || resp.Listener == "" {
		t.Fatalf("listen: %+v", resp)
	}
	return h, resp
}

func dialSocket(t *testing.T, path string) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(5 * time.Second))
	return c
}

func requireClosed(t *testing.T, c net.Conn) {
	t.Helper()
	if _, err := c.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("read: %v, want EOF", err)
	}
}

func TestSocketIsTheUsersAlone(t *testing.T) {
	m := newManager(t)
	_, resp := listen(t, m)

	for path, want := range map[string]os.FileMode{resp.Path: 0o600, filepath.Dir(resp.Path): 0o700} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s: mode %o, want %o", path, got, want)
		}
	}
}

func TestClientIsRelayedAndSocketGoesWithTheHost(t *testing.T) {
	m := newManager(t)
	control, resp := listen(t, m)

	client := dialSocket(t, resp.Path)
	var conn proto.Connection
	control.next(t, proto.TypeConnection, &conn)

	relay := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Accept(proto.Request{Listener: resp.Listener, Connection: conn.ID}, r, w)
	})
	relay.next(t, proto.TypeResponse, nil)

	// the client's request reaches the host, the host's answer the client
	if _, err := client.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	f, err := relay.r.Next()
	if err != nil || f.Type != proto.TypeStdout || string(f.Payload) != "request" {
		t.Fatalf("got %v %v", f, err)
	}
	if err := relay.w.Write(proto.TypeStdin, []byte("answer")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 6)
	if _, err := io.ReadFull(client, buf); err != nil || string(buf) != "answer" {
		t.Fatalf("client read %q, %v", buf, err)
	}

	control.conn.Close()
	if err := <-control.served; err != nil {
		t.Fatalf("listen: %v", err)
	}
	if _, err := os.Stat(filepath.Dir(resp.Path)); !os.IsNotExist(err) {
		t.Fatalf("socket dir still there: %v", err)
	}
}

// impd refuses a client when the user's ssh refuses the agent channel; the
// client must see the close at once, not after the pending timeout
func TestAcceptThatClosesEndsTheClient(t *testing.T) {
	m := newManager(t)
	control, resp := listen(t, m)

	client := dialSocket(t, resp.Path)
	var conn proto.Connection
	control.next(t, proto.TypeConnection, &conn)

	relay := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Accept(proto.Request{Listener: resp.Listener, Connection: conn.ID}, r, w)
	})
	relay.next(t, proto.TypeResponse, nil)
	relay.conn.Close()

	requireClosed(t, client)
}

func TestUnknownConnection(t *testing.T) {
	m := newManager(t)
	_, resp := listen(t, m)

	relay := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Accept(proto.Request{Listener: resp.Listener, Connection: 99}, r, w)
	})
	var got proto.ErrorResponse
	relay.next(t, proto.TypeResponse, &got)
	if got.Error == nil || got.Error.Code != proto.ErrNoConnection {
		t.Fatalf("got %+v, want NO_CONNECTION", got)
	}
}

func TestWaitingClientsAreCapped(t *testing.T) {
	m := newManager(t)
	control, resp := listen(t, m)

	for i := range maxPending {
		dialSocket(t, resp.Path)
		var conn proto.Connection
		control.next(t, proto.TypeConnection, &conn)
		if conn.ID != uint64(i+1) {
			t.Fatalf("connection %d has id %d", i+1, conn.ID)
		}
	}
	requireClosed(t, dialSocket(t, resp.Path))
}

func TestUnpairedClientTimesOut(t *testing.T) {
	old := pendingTimeout
	pendingTimeout = 50 * time.Millisecond
	t.Cleanup(func() { pendingTimeout = old })

	m := newManager(t)
	control, resp := listen(t, m)

	client := dialSocket(t, resp.Path)
	control.next(t, proto.TypeConnection, nil)

	requireClosed(t, client)
}

func TestOtherUsersAreRefused(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root is always allowed")
	}
	t.Chdir(t.TempDir())
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: "s", Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	dialSocket(t, "s")
	c, err := ln.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	owner := &listener{uid: uint32(os.Getuid())}
	other := &listener{uid: 65534}
	if !owner.allows(c) || other.allows(c) {
		t.Fatalf("owner allows %v, other allows %v", owner.allows(c), other.allows(c))
	}
}

func TestBadUserFails(t *testing.T) {
	t.Chdir(t.TempDir())
	m := NewManager("agents", "forwards", "no-such-user", testBinder(), fsroot.Host)
	h := startHost(t, m.ServeAgent)
	var got proto.ErrorResponse
	h.next(t, proto.TypeResponse, &got)
	if got.Error == nil {
		t.Fatalf("got %+v, want an error", got)
	}
	if entries, _ := os.ReadDir("agents"); len(entries) != 0 {
		t.Fatalf("left %d dirs", len(entries))
	}
}

// serveListen starts a listen connection and reads its answer
func serveListen(t *testing.T, m *Manager, network, address string) (*host, proto.Listening, *proto.Error) {
	t.Helper()
	h := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Serve(proto.Request{Network: network, Address: address}, r, w)
	})
	f, err := h.r.Next()
	if err != nil || f.Type != proto.TypeResponse {
		t.Fatalf("listen answer: %v %v", f, err)
	}
	var failed proto.ErrorResponse
	if json.Unmarshal(f.Payload, &failed) == nil && failed.Error != nil {
		return h, proto.Listening{}, failed.Error
	}
	var resp proto.Listening
	if err := json.Unmarshal(f.Payload, &resp); err != nil || !resp.OK || resp.Listener == "" {
		t.Fatalf("listen: %s %v", f.Payload, err)
	}
	return h, resp, nil
}

func requireListening(t *testing.T, m *Manager, network, address string) (*host, proto.Listening) {
	t.Helper()
	h, resp, failed := serveListen(t, m, network, address)
	if failed != nil {
		t.Fatalf("listen %s %s: %v", network, address, failed)
	}
	return h, resp
}

func requireRefused(t *testing.T, m *Manager, network, address, code string) {
	t.Helper()
	_, _, failed := serveListen(t, m, network, address)
	if failed == nil || failed.Code != code {
		t.Fatalf("listen %s %q: got %v, want %s", network, address, failed, code)
	}
}

// relayOnce pairs the next client with an accept and checks bytes reach the
// host
func relayOnce(t *testing.T, m *Manager, control *host, listener string, client net.Conn) {
	t.Helper()
	var conn proto.Connection
	control.next(t, proto.TypeConnection, &conn)
	relay := startHost(t, func(r *proto.Reader, w *proto.Writer) error {
		return m.Accept(proto.Request{Listener: listener, Connection: conn.ID}, r, w)
	})
	relay.next(t, proto.TypeResponse, nil)
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	f, err := relay.r.Next()
	if err != nil || f.Type != proto.TypeStdout || string(f.Payload) != "ping" {
		t.Fatalf("got %v %v", f, err)
	}
}

func endListener(t *testing.T, control *host) {
	t.Helper()
	control.conn.Close()
	if err := <-control.served; err != nil {
		t.Fatalf("listen: %v", err)
	}
}

func TestAForwardWithNoPathGetsASocketOfItsOwn(t *testing.T) {
	m := newManager(t)
	control, resp := requireListening(t, m, "unix", "")

	if filepath.Base(filepath.Dir(filepath.Dir(resp.Path))) != "forwards" {
		t.Fatalf("path %s is not under the forward root", resp.Path)
	}
	for path, want := range map[string]os.FileMode{resp.Path: 0o600, filepath.Dir(resp.Path): 0o700} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s: mode %o, want %o", path, got, want)
		}
	}
	relayOnce(t, m, control, resp.Listener, dialSocket(t, resp.Path))

	endListener(t, control)
	if _, err := os.Stat(filepath.Dir(resp.Path)); !os.IsNotExist(err) {
		t.Fatalf("socket dir still there: %v", err)
	}
}

func TestAClientPathIsBoundRelayedAndRemoved(t *testing.T) {
	m := newManager(t)
	path := inCwd(t, "app.sock")
	control, resp := requireListening(t, m, "unix", path)

	if resp.Path != path {
		t.Fatalf("path %s, want %s", resp.Path, path)
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket %v, %v", info, err)
	}
	relayOnce(t, m, control, resp.Listener, dialSocket(t, "app.sock"))

	endListener(t, control)
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("the socket is still there: %v", err)
	}
}

// a forward that ended with a forced sleep leaves its socket; the next
// listen on the path replaces it
func TestAStaleSocketIsReplaced(t *testing.T) {
	m := newManager(t)
	path := inCwd(t, "app.sock")
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: "app.sock", Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	stale.Close()

	control, _ := requireListening(t, m, "unix", path)
	dialSocket(t, "app.sock")
	control.next(t, proto.TypeConnection, nil)
}

func TestAFileThatIsNotASocketIsKept(t *testing.T) {
	m := newManager(t)
	path := inCwd(t, "notes")
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	requireRefused(t, m, "unix", path, proto.ErrListenFailed)
	if b, err := os.ReadFile(path); err != nil || string(b) != "keep" {
		t.Fatalf("the file became %q, %v", b, err)
	}
}

func TestBadListenRequests(t *testing.T) {
	m := newManager(t)
	missing := filepath.Join(t.TempDir(), "no", "such", "app.sock")

	requireRefused(t, m, "unix", missing, proto.ErrBadRequest)
	requireRefused(t, m, "unix", "relative.sock", proto.ErrBadRequest)
	requireRefused(t, m, "tcp", "0.0.0.0:0", proto.ErrBadRequest)
	requireRefused(t, m, "tcp", "127.0.0.1:70000", proto.ErrBadRequest)
	requireRefused(t, m, "udp", "127.0.0.1:0", proto.ErrBadRequest)
}

// the listener removes its own socket and nothing a process put at the
// name meanwhile
func TestCloseLeavesAnotherSocketAtThePathAlone(t *testing.T) {
	m := newManager(t)
	path := inCwd(t, "app.sock")
	control, _ := requireListening(t, m, "unix", path)

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	other, err := net.ListenUnix("unix", &net.UnixAddr{Name: "app.sock", Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()

	endListener(t, control)
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("the other socket went: %v", err)
	}
}

func TestATCPPortOnLoopback(t *testing.T) {
	m := newManager(t)
	control, resp := requireListening(t, m, "tcp", "127.0.0.1:0")

	if resp.Port == 0 || resp.Path != "" {
		t.Fatalf("got %+v, want a port", resp)
	}
	client, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", resp.Port))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	relayOnce(t, m, control, resp.Listener, client)

	endListener(t, control)
	if c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", resp.Port)); err == nil {
		c.Close()
		t.Fatal("the port still listens")
	}
}

// inCwd is name in the test's directory, which newManager made the working
// directory: clients dial the short relative name, under the 108-byte limit
// of a unix socket path, which the bind, through /proc/self/fd, does not have
func inCwd(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, name)
}
