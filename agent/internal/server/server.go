// Package server accepts host connections on vsock and dispatches requests.
// One request per connection; see PROTOCOL.md.
package server

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/services"
)

// Port is the vsock port the agent listens on.
const Port = 1024

// requestTimeout bounds how long a fresh connection may take to send its
// request frame.
const requestTimeout = 10 * time.Second

type Server struct {
	Exec     *exec.Manager
	Services *services.Supervisor
	// Shutdown powers the guest off. It runs after the reply is sent.
	Shutdown func()

	freezeMu  sync.Mutex
	thawTimer *time.Timer
}

// Listen backoff bounds. A snapshot restore resets the vsock transport; the
// listen socket should survive it, but if Accept fails anyway the agent
// re-listens rather than return, because Serve returning reboots the guest.
const (
	minRelistenDelay = 10 * time.Millisecond
	maxRelistenDelay = time.Second
)

// Serve accepts connections forever. When Accept fails, it closes the
// listener and calls listen again, with backoff. It returns only if the
// first listen fails.
func (s *Server) Serve(listen func() (net.Listener, error)) error {
	l, err := listen()
	if err != nil {
		return err
	}
	delay := minRelistenDelay
	for {
		c, err := l.Accept()
		if err == nil {
			delay = minRelistenDelay
			go s.handle(c)
			continue
		}
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			continue
		}
		log.Printf("accept: %v; listening again", err)
		l.Close()
		for {
			time.Sleep(delay)
			delay = min(delay*2, maxRelistenDelay)
			if l, err = listen(); err == nil {
				break
			}
			log.Printf("listen: %v", err)
		}
	}
}

func (s *Server) handle(c net.Conn) {
	defer c.Close()
	r, w := proto.NewReader(c), proto.NewWriter(c)

	c.SetReadDeadline(time.Now().Add(requestTimeout))
	f, err := r.Next()
	c.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	if f.Type != proto.TypeRequest {
		replyErr(w, proto.ErrBadRequest, "first frame must be REQUEST, got "+f.Type.String())
		return
	}
	var req proto.Request
	if err := json.Unmarshal(f.Payload, &req); err != nil {
		replyErr(w, proto.ErrBadRequest, err.Error())
		return
	}

	if req.Op == proto.OpExec {
		if err := s.Exec.Serve(req, r, w); err != nil {
			log.Printf("exec: %v", err)
		}
		return
	}
	resp, err := s.unary(req)
	if err != nil {
		var pe *proto.Error
		if !errors.As(err, &pe) {
			pe = &proto.Error{Code: proto.ErrInternal, Message: err.Error()}
		}
		w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: pe})
		return
	}
	w.WriteJSON(proto.TypeResponse, resp)
	if req.Op == proto.OpShutdown {
		c.Close()
		s.Shutdown()
	}
}

func (s *Server) unary(req proto.Request) (any, error) {
	switch req.Op {
	case proto.OpPing:
		return proto.Ping{OK: true, Version: proto.Version, UptimeMs: uptimeMs()}, nil
	case proto.OpActivity:
		return s.activity()
	case proto.OpFreeze:
		return proto.OK{OK: true}, s.freeze(time.Duration(req.TimeoutMs) * time.Millisecond)
	case proto.OpThaw:
		return proto.OK{OK: true}, s.thaw()
	case proto.OpResumed:
		if req.UnixMs <= 0 {
			return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "unix_ms is required"}
		}
		ts := unix.NsecToTimespec(req.UnixMs * int64(time.Millisecond))
		return proto.OK{OK: true}, unix.ClockSettime(unix.CLOCK_REALTIME, &ts)
	case proto.OpServicesList:
		return proto.ServicesList{Services: s.Services.List()}, nil
	case proto.OpShutdown:
		return proto.OK{OK: true}, nil
	default:
		return nil, &proto.Error{Code: proto.ErrUnknownOp, Message: "unknown op " + req.Op}
	}
}

func replyErr(w *proto.Writer, code, msg string) {
	w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: &proto.Error{Code: code, Message: msg}})
}

func uptimeMs() int64 {
	var ts unix.Timespec
	if unix.ClockGettime(unix.CLOCK_BOOTTIME, &ts) != nil {
		return 0
	}
	return ts.Nano() / int64(time.Millisecond)
}
