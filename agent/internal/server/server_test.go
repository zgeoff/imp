package server

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

// The reaper runs a process-wide wait4 loop: two in one process would reap
// each other's children, so the package shares one.
var testReaper *reaper.Reaper

func TestMain(m *testing.M) {
	testReaper = reaper.New()
	os.Exit(m.Run())
}

// failListener fails every Accept, as a listener broken by a vsock transport
// reset would.
type failListener struct{ net.Listener }

func (failListener) Accept() (net.Conn, error) { return nil, errors.New("connection reset") }
func (failListener) Close() error              { return nil }

// Serve survives a failing listener by listening again, instead of
// returning (which would reboot the guest).
func TestServeListensAgainAfterAFailedAccept(t *testing.T) {
	good, err := net.Listen("tcp", "127.0.0.1:0")
	assert.NilError(t, err)
	t.Cleanup(func() { good.Close() })
	var calls atomic.Int32
	// Serve never returns once it listens; after the test, listen ends its
	// goroutine instead, so cleanup can join it.
	var stopped atomic.Bool
	listen := func() (net.Listener, error) {
		if stopped.Load() {
			runtime.Goexit()
		}
		switch calls.Add(1) {
		case 1:
			return failListener{}, nil
		case 2:
			return nil, errors.New("listen: try again")
		default:
			return good, nil
		}
	}

	served := make(chan error, 1)
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		served <- (&Server{}).Serve(listen)
	}()
	t.Cleanup(func() {
		stopped.Store(true)
		// the next Accept fails, and Serve's relisten ends the goroutine
		good.Close()
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
			t.Error("Serve's goroutine did not end")
		}
	})

	c, err := net.DialTimeout("tcp", good.Addr().String(), time.Second)
	assert.NilError(t, err)
	t.Cleanup(func() { c.Close() })
	// handle() closes a connection whose first frame is not a REQUEST, after
	// a BAD_REQUEST reply.
	assert.NilError(t, c.SetDeadline(time.Now().Add(5*time.Second)))
	_, err = c.Write([]byte{9, 0, 0, 0, 0})
	assert.NilError(t, err)
	buf := make([]byte, 64)
	n, _ := c.Read(buf)
	assert.Check(t, n > 0, "no reply from the re-created listener")
	select {
	case err := <-served:
		t.Errorf("Serve returned: %v", err)
	default:
	}
	assert.Check(t, cmp.Equal(calls.Load(), int32(3)), "listen calls")
}

func TestServeReturnsTheErrorOfAFailedFirstListen(t *testing.T) {
	failed := errors.New("no vsock")

	err := (&Server{}).Serve(func() (net.Listener, error) { return nil, failed })

	assert.ErrorIs(t, err, failed)
}

// roundTrip runs one request through handle and returns the RESPONSE
// payload, or nil if the connection closed without one.
func roundTrip(t *testing.T, s *Server, req proto.Request) []byte {
	t.Helper()
	b, err := json.Marshal(req)
	assert.NilError(t, err)
	return roundTripFrame(t, s, proto.TypeRequest, b)
}

// roundTripFrame sends one frame as a connection's first and returns the
// reply's payload, or nil if the connection closed without one.
func roundTripFrame(t *testing.T, s *Server, typ proto.Type, payload []byte) []byte {
	t.Helper()
	host, guest := net.Pipe()
	t.Cleanup(func() { host.Close() })
	done := make(chan struct{})
	go func() { s.handle(guest); close(done) }()
	assert.NilError(t, host.SetDeadline(time.Now().Add(5*time.Second)))
	assert.NilError(t, proto.NewWriter(host).Write(typ, payload))
	f, err := proto.NewReader(host).Next()
	<-done
	if err != nil {
		return nil
	}
	return f.Payload
}

// errorCode reads the code of an error RESPONSE payload.
func errorCode(t *testing.T, payload []byte) string {
	t.Helper()
	var er proto.ErrorResponse
	assert.NilError(t, json.Unmarshal(payload, &er), "reply %s", payload)
	assert.Assert(t, er.Error != nil, "reply %s is not an error", payload)
	return er.Error.Code
}

func TestHandleRefusesAFirstFrameThatIsNotARequest(t *testing.T) {
	resp := roundTripFrame(t, &Server{}, proto.TypeStdin, []byte("hi"))

	assert.Equal(t, errorCode(t, resp), proto.ErrBadRequest)
}

func TestHandleRefusesARequestThatIsNotJSON(t *testing.T) {
	resp := roundTripFrame(t, &Server{}, proto.TypeRequest, []byte("{"))

	assert.Equal(t, errorCode(t, resp), proto.ErrBadRequest)
}

func TestHandleRefusesAnUnknownOp(t *testing.T) {
	resp := roundTrip(t, &Server{}, proto.Request{Op: "imp-test-none"})

	assert.Equal(t, errorCode(t, resp), proto.ErrUnknownOp)
}

func TestHandleRefusesARequestWithoutItsRequiredField(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  proto.Request
	}{
		{name: "resumed without unix_ms", req: proto.Request{Op: proto.OpResumed}},
		{name: "grow without disk_bytes", req: proto.Request{Op: proto.OpGrow}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := roundTrip(t, &Server{}, tc.req)

			assert.Equal(t, errorCode(t, resp), proto.ErrBadRequest)
		})
	}
}

// A freeze over the wire that finds the root frozen replies FROZEN.
func TestHandleRepliesFrozenToASecondFreeze(t *testing.T) {
	var f fakeIoctl
	f.install(t)
	s := &Server{}
	assert.NilError(t, s.freeze(time.Hour))
	t.Cleanup(func() { s.thaw() })

	resp := roundTrip(t, s, proto.Request{Op: proto.OpFreeze, TimeoutMs: 1000})

	assert.Equal(t, errorCode(t, resp), proto.ErrFrozen)
}
