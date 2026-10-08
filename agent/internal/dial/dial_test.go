package dial

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

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
	t.Cleanup(func() { hostEnd.Close() })
	assert.NilError(t, hostEnd.SetDeadline(time.Now().Add(5*time.Second)))
	h := &host{conn: hostEnd, r: proto.NewReader(hostEnd), w: proto.NewWriter(hostEnd), served: make(chan error, 1)}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		h.served <- testDialer("").Serve(req, proto.NewReader(guestEnd), proto.NewWriter(guestEnd))
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

func (h *host) next(t *testing.T) proto.Frame {
	t.Helper()
	f, err := h.r.Next()
	assert.NilError(t, err, "read frame")
	return f
}

func (h *host) requireOK(t *testing.T) {
	t.Helper()
	f := h.next(t)
	assert.Equal(t, f.Type, proto.TypeResponse, "frame %s", f.Payload)
	assert.Equal(t, string(f.Payload), `{"ok":true}`)
}

// errorCode reads the error RESPONSE and returns its code.
func (h *host) errorCode(t *testing.T) string {
	t.Helper()
	f := h.next(t)
	assert.Equal(t, f.Type, proto.TypeResponse, "frame %s", f.Payload)
	var resp proto.ErrorResponse
	assert.NilError(t, json.Unmarshal(f.Payload, &resp))
	assert.Assert(t, resp.Error != nil, "RESPONSE %s is no error", f.Payload)
	return resp.Error.Code
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

// listen hands each connection to handle on a goroutine of its own.
func listen(t *testing.T, network, address string, handle func(net.Conn)) net.Addr {
	t.Helper()
	l, err := net.Listen(network, address)
	assert.NilError(t, err)
	serveConns(t, l, handle)
	return l.Addr()
}

// serveConns accepts on l until cleanup and hands each connection to handle.
// Cleanup closes l and every connection, then waits for the accept loop and
// every handler to return.
func serveConns(t *testing.T, l net.Listener, handle func(net.Conn)) {
	t.Helper()
	var (
		mu    sync.Mutex
		conns []net.Conn
		wg    sync.WaitGroup
	)
	t.Cleanup(func() {
		l.Close()
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		mu.Unlock()
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("a connection handler did not return")
		}
	})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer c.Close()
				handle(c)
			}()
		}
	}()
}

// The target reads to EOF and only then answers: it works only when the
// host's STDIN_EOF reaches it as a half-close, and the host learns the end of
// the answer from STDOUT_EOF.
func TestServeRelaysWithAHalfCloseBothWays(t *testing.T) {
	for _, tc := range []struct {
		network string
		address func(t *testing.T) string
	}{
		{network: "tcp", address: func(*testing.T) string { return "127.0.0.1:0" }},
		{network: "unix", address: func(t *testing.T) string { return filepath.Join(shortDir(t), "target.sock") }},
	} {
		t.Run(tc.network, func(t *testing.T) {
			t.Parallel()
			addr := listen(t, tc.network, tc.address(t), func(c net.Conn) {
				got, _ := io.ReadAll(c)
				c.Write([]byte("got " + string(got)))
			})
			h := startServe(t, proto.Request{Op: proto.OpDial, Network: tc.network, Address: addr.String()})
			h.requireOK(t)

			assert.NilError(t, h.w.Write(proto.TypeStdin, []byte("hello ")))
			assert.NilError(t, h.w.Write(proto.TypeStdin, []byte("world")))
			assert.NilError(t, h.w.Write(proto.TypeStdinEOF, nil))
			var out []byte
			for {
				f := h.next(t)
				if f.Type == proto.TypeStdoutEOF {
					break
				}
				assert.Equal(t, f.Type, proto.TypeStdout)
				out = append(out, f.Payload...)
			}
			served := h.waitServed(t)

			assert.Check(t, cmp.Equal(string(out), "got hello world"))
			assert.Check(t, served, "Serve")
		})
	}
}

func TestServeFailsTheDialToARefusedPort(t *testing.T) {
	t.Parallel()
	// A socket bound but never listening holds its port, so no other
	// listener can take it, and a connect to it is refused.
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	assert.NilError(t, err)
	t.Cleanup(func() { syscall.Close(fd) })
	assert.NilError(t, syscall.Bind(fd, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}))
	sa, err := syscall.Getsockname(fd)
	assert.NilError(t, err)
	address := fmt.Sprintf("127.0.0.1:%d", sa.(*syscall.SockaddrInet4).Port)

	h := startServe(t, proto.Request{Op: proto.OpDial, Network: "tcp", Address: address})

	assert.Check(t, cmp.Equal(h.errorCode(t), proto.ErrDialFailed))
	h.waitServed(t)
}

func TestServeRefusesABadDialRequest(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  proto.Request
	}{
		{name: "udp", req: proto.Request{Op: proto.OpDial, Network: "udp", Address: "127.0.0.1:53"}},
		{name: "no address", req: proto.Request{Op: proto.OpDial, Network: "tcp"}},
		{name: "a relative unix path", req: proto.Request{Op: proto.OpDial, Network: "unix", Address: "echo.sock"}},
		{name: "an abstract socket", req: proto.Request{Op: proto.OpDial, Network: "unix", Address: "@abstract"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			h := startServe(t, tc.req)

			assert.Check(t, cmp.Equal(h.errorCode(t), proto.ErrBadRequest))
			h.waitServed(t)
		})
	}
}

// A host that closes the connection ends the relay, even while the target
// neither writes nor closes.
func TestServeEndsTheRelayWhenTheHostCloses(t *testing.T) {
	t.Parallel()
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
func TestServeEndsWithoutStdoutEOFWhenTheTargetResets(t *testing.T) {
	t.Parallel()
	// The target resets only once the host half-closed: a reset right after
	// the accept can reach the agent before its connect completes, and the
	// dial then fails with ECONNRESET instead of relaying.
	addr := listen(t, "tcp", "127.0.0.1:0", func(c net.Conn) {
		io.Copy(io.Discard, c)
		c.Write([]byte("partial"))
		c.(*net.TCPConn).SetLinger(0)
	})
	h := startServe(t, proto.Request{Op: proto.OpDial, Network: "tcp", Address: addr.String()})
	h.requireOK(t)

	assert.NilError(t, h.w.Write(proto.TypeStdinEOF, nil))
	// read every frame until the relay ends the connection
	var types []proto.Type
	for f, err := h.r.Next(); err == nil; f, err = h.r.Next() {
		types = append(types, f.Type)
	}
	h.waitServed(t)

	assert.Check(t, !slices.Contains(types, proto.TypeStdoutEOF), "got STDOUT_EOF after a reset: %v", types)
}
