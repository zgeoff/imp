package dial

import (
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// host is the host end of a dial connection, with Serve running on the
// other end.
type host struct {
	conn   net.Conn
	r      *proto.Reader
	w      *proto.Writer
	served chan error
}

func startServe(t *testing.T, req proto.Request) *host {
	t.Helper()
	hostEnd, guestEnd := net.Pipe()
	h := &host{conn: hostEnd, r: proto.NewReader(hostEnd), w: proto.NewWriter(hostEnd), served: make(chan error, 1)}
	go func() {
		h.served <- Serve(req, proto.NewReader(guestEnd), proto.NewWriter(guestEnd))
		guestEnd.Close()
	}()
	t.Cleanup(func() { hostEnd.Close() })
	hostEnd.SetDeadline(time.Now().Add(5 * time.Second))
	return h
}

func (h *host) next(t *testing.T) proto.Frame {
	t.Helper()
	f, err := h.r.Next()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return f
}

func (h *host) requireOK(t *testing.T) {
	t.Helper()
	f := h.next(t)
	if f.Type != proto.TypeResponse || string(f.Payload) != `{"ok":true}` {
		t.Fatalf("got %s %s, want RESPONSE ok", f.Type, f.Payload)
	}
}

func (h *host) requireError(t *testing.T, code string) {
	t.Helper()
	f := h.next(t)
	var resp proto.ErrorResponse
	if f.Type != proto.TypeResponse || json.Unmarshal(f.Payload, &resp) != nil || resp.Error == nil {
		t.Fatalf("got %s %s, want an error RESPONSE", f.Type, f.Payload)
	}
	if resp.Error.Code != code {
		t.Fatalf("error code %s (%s), want %s", resp.Error.Code, resp.Error.Message, code)
	}
}

func (h *host) waitServed(t *testing.T) error {
	t.Helper()
	select {
	case err := <-h.served:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return")
		return nil
	}
}

// listen accepts one connection and hands it to handle.
func listen(t *testing.T, network, address string, handle func(net.Conn)) net.Addr {
	t.Helper()
	l, err := net.Listen(network, address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		handle(c)
	}()
	return l.Addr()
}

// The target reads to EOF and only then answers: it works only when the
// host's STDIN_EOF reaches it as a half-close, and the host learns the end of
// the answer from STDOUT_EOF.
func TestRelaysWithHalfCloseBothWays(t *testing.T) {
	for _, network := range []string{"tcp", "unix"} {
		t.Run(network, func(t *testing.T) {
			address := "127.0.0.1:0"
			if network == "unix" {
				address = filepath.Join(t.TempDir(), "target.sock")
			}
			addr := listen(t, network, address, func(c net.Conn) {
				got, _ := io.ReadAll(c)
				c.Write([]byte("got " + string(got)))
			})
			h := startServe(t, proto.Request{Op: proto.OpDial, Network: network, Address: addr.String()})
			h.requireOK(t)

			h.w.Write(proto.TypeStdin, []byte("hello "))
			h.w.Write(proto.TypeStdin, []byte("world"))
			h.w.Write(proto.TypeStdinEOF, nil)

			var out []byte
			for {
				f := h.next(t)
				if f.Type == proto.TypeStdoutEOF {
					break
				}
				if f.Type != proto.TypeStdout {
					t.Fatalf("got %s, want STDOUT", f.Type)
				}
				out = append(out, f.Payload...)
			}
			if string(out) != "got hello world" {
				t.Fatalf("output %q", out)
			}
			if err := h.waitServed(t); err != nil {
				t.Fatalf("Serve: %v", err)
			}
		})
	}
}

func TestRefusedPortFailsTheDial(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := l.Addr().String()
	l.Close()

	h := startServe(t, proto.Request{Op: proto.OpDial, Network: "tcp", Address: address})
	h.requireError(t, proto.ErrDialFailed)
	h.waitServed(t)
}

func TestBadRequests(t *testing.T) {
	for _, req := range []proto.Request{
		{Op: proto.OpDial, Network: "udp", Address: "127.0.0.1:53"},
		{Op: proto.OpDial, Network: "tcp"},
	} {
		h := startServe(t, req)
		h.requireError(t, proto.ErrBadRequest)
		h.waitServed(t)
	}
}

// A host that closes the connection ends the relay, even while the target
// neither writes nor closes.
func TestHostCloseEndsTheRelay(t *testing.T) {
	targetClosed := make(chan struct{})
	addr := listen(t, "tcp", "127.0.0.1:0", func(c net.Conn) {
		io.Copy(io.Discard, c)
		close(targetClosed)
	})
	h := startServe(t, proto.Request{Op: proto.OpDial, Network: "tcp", Address: addr.String()})
	h.requireOK(t)
	h.conn.Close()

	h.waitServed(t)
	select {
	case <-targetClosed:
	case <-time.After(5 * time.Second):
		t.Fatal("the target connection stayed open")
	}
}

// After the host half-closed, a target that resets ends the relay without
// STDOUT_EOF.
func TestTargetResetEndsWithoutEOF(t *testing.T) {
	addr := listen(t, "tcp", "127.0.0.1:0", func(c net.Conn) {
		c.Write([]byte("partial"))
		c.(*net.TCPConn).SetLinger(0)
	})
	h := startServe(t, proto.Request{Op: proto.OpDial, Network: "tcp", Address: addr.String()})
	h.requireOK(t)

	for {
		f, err := h.r.Next()
		if err != nil {
			break
		}
		if f.Type == proto.TypeStdoutEOF {
			t.Fatal("got STDOUT_EOF after a reset")
		}
	}
	h.waitServed(t)
}
