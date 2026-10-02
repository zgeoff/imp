// Package dial serves a dial request: it connects to an address inside the
// guest and relays bytes both ways over the host connection. impd's SSH
// gateway and `imp proxy` use it, so a forward reaches a program that listens
// on the guest's loopback, which the guest IP cannot. A TCP dial runs as root;
// a unix socket dial runs as the image's USER (unixdial.go).
package dial

import (
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// dialTimeout bounds the connect, so a filtered port fails instead of
// holding the host's channel open.
const dialTimeout = 5 * time.Second

// impDir holds the agent's own sockets, such as forwarded ssh-agents. impd
// refuses the path, and connectUnix refuses a symlink that leads there. A
// variable for tests.
var impDir = "/run/imp"

// chunk is the most the relay reads from the target before it writes a frame.
const chunk = 32 << 10

// halfCloser is a connection whose write side closes on its own: TCP and
// unix stream sockets both have it.
type halfCloser interface {
	CloseWrite() error
}

// Serve dials req's address and relays until both sides are done. r and w
// are the host connection's frame streams; the caller closes it after Serve
// returns, which also ends a relay the host gave up on.
func (d *Dialer) Serve(req proto.Request, r *proto.Reader, w *proto.Writer) error {
	target, err := d.open(req)
	if err != nil {
		return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: toProtoError(err)})
	}
	defer target.Close()
	if err := w.WriteJSON(proto.TypeResponse, proto.OK{OK: true}); err != nil {
		return err
	}
	return Relay(target, r, w)
}

// Relay copies bytes between target and the host connection until both
// sides are done: the target's output ran out and the host half-closed. The
// caller has already sent the RESPONSE, and closes target afterwards. The
// agent's ssh-agent forwarding relays its clients here too.
func Relay(target net.Conn, r *proto.Reader, w *proto.Writer) error {
	// target → host. STDOUT_EOF tells the host the target closed its side;
	// a read error ends the relay without it, so the host sees a reset.
	outbound := make(chan error, 1)
	safe.Go("relay output", func() {
		outbound <- pumpOut(target, w)
	}, func() {
		outbound <- errors.New("relay output panicked")
	})

	// host → target. It reads until the host closes the connection, past
	// STDIN_EOF, so a host that gives up is seen even while the target is
	// quiet.
	halfClosed := make(chan struct{})
	inbound := make(chan error, 1)
	safe.Go("relay input", func() {
		inbound <- pumpIn(r, target, halfClosed)
	}, func() {
		inbound <- errors.New("relay input panicked")
	})

	// Done once the target's output ran out and the host half-closed. A
	// failure on either side ends the relay; the deferred close stops the
	// other pump.
	outDone := false
	for {
		select {
		case err := <-outbound:
			if err != nil {
				return err
			}
			outDone = true
		case <-halfClosed:
			halfClosed = nil
		case err := <-inbound:
			return err
		}
		if outDone && halfClosed == nil {
			return nil
		}
	}
}

func (d *Dialer) open(req proto.Request) (net.Conn, error) {
	if req.Network != "tcp" && req.Network != "unix" {
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("network must be tcp or unix, got %q", req.Network)}
	}
	if req.Address == "" {
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "address is required"}
	}
	if req.Network == "unix" {
		return d.openUnix(req.Address)
	}
	c, err := net.DialTimeout(req.Network, req.Address, dialTimeout)
	if err != nil {
		return nil, &proto.Error{Code: proto.ErrDialFailed, Message: err.Error()}
	}
	return c, nil
}

func pumpOut(target net.Conn, w *proto.Writer) error {
	buf := make([]byte, chunk)
	for {
		n, err := target.Read(buf)
		if n > 0 {
			if werr := w.Write(proto.TypeStdout, buf[:n]); werr != nil {
				return werr
			}
		}
		if errors.Is(err, io.EOF) {
			return w.Write(proto.TypeStdoutEOF, nil)
		}
		if err != nil {
			return err
		}
	}
}

// pumpIn writes STDIN frames to the target. STDIN_EOF closes the target's
// write side and closes halfClosed. It returns when the host connection
// fails, or nil when the host closes it: the host may end a relay at any time.
func pumpIn(r *proto.Reader, target net.Conn, halfClosed chan<- struct{}) error {
	ended := false
	for {
		f, err := r.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read from the host: %w", err)
		}
		switch {
		case f.Type == proto.TypeStdin && !ended:
			if _, err := target.Write(f.Payload); err != nil {
				return err
			}
		case f.Type == proto.TypeStdinEOF && !ended:
			ended = true
			if hc, ok := target.(halfCloser); ok {
				if err := hc.CloseWrite(); err != nil {
					return err
				}
			}
			close(halfClosed)
		}
	}
}

func toProtoError(err error) *proto.Error {
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe
	}
	return &proto.Error{Code: proto.ErrInternal, Message: err.Error()}
}
