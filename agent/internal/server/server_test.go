package server

import (
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

// failListener fails every Accept, as a listener broken by a vsock transport
// reset would.
type failListener struct{ net.Listener }

func (failListener) Accept() (net.Conn, error) { return nil, errors.New("connection reset") }
func (failListener) Close() error              { return nil }

// TestServeRelistens checks that Serve survives a failing listener by
// listening again, instead of returning (which would reboot the guest).
func TestServeRelistens(t *testing.T) {
	good, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer good.Close()

	var calls atomic.Int32
	listen := func() (net.Listener, error) {
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
	go func() { served <- (&Server{}).Serve(listen) }()

	c, err := net.DialTimeout("tcp", good.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// handle() closes a connection whose first frame is not a REQUEST.
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte{9, 0, 0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	if n, _ := c.Read(buf); n == 0 {
		t.Fatal("no reply from the re-created listener")
	}
	select {
	case err := <-served:
		t.Fatalf("Serve returned: %v", err)
	default:
	}
	if n := calls.Load(); n != 3 {
		t.Fatalf("listen called %d times, want 3", n)
	}
}

func TestServeFirstListenFails(t *testing.T) {
	err := (&Server{}).Serve(func() (net.Listener, error) { return nil, errors.New("no vsock") })
	if err == nil {
		t.Fatal("Serve returned nil")
	}
}
