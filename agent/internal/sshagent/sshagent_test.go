package sshagent

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
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
	return NewManager("agents", fmt.Sprint(os.Getuid()))
}

func listen(t *testing.T, m *Manager) (*host, proto.AgentListen) {
	t.Helper()
	h := startHost(t, m.Listen)
	var resp proto.AgentListen
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
	m := NewManager("agents", "no-such-user")
	h := startHost(t, m.Listen)
	var got proto.ErrorResponse
	h.next(t, proto.TypeResponse, &got)
	if got.Error == nil {
		t.Fatalf("got %+v, want an error", got)
	}
	if entries, _ := os.ReadDir("agents"); len(entries) != 0 {
		t.Fatalf("left %d dirs", len(entries))
	}
}
