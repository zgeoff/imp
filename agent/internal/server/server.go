// Package server accepts host connections on vsock and dispatches requests.
// One request per connection; see docs/architecture/guest/protocol.md.
package server

import (
	"errors"
	"log"
	"net"
	"sync"
	"time"

	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/zgeoff/impz/agent/internal/dial"
	"github.com/zgeoff/impz/agent/internal/exec"
	"github.com/zgeoff/impz/agent/internal/files"
	"github.com/zgeoff/impz/agent/internal/listen"
	"github.com/zgeoff/impz/agent/internal/proto"
	"github.com/zgeoff/impz/agent/internal/safe"
	"github.com/zgeoff/impz/agent/internal/services"
	"github.com/zgeoff/impz/agent/internal/session"
)

// Port is the vsock port the agent listens on.
const Port = 1024

// requestTimeout bounds how long a fresh connection may take to send its
// request frame.
const requestTimeout = 10 * time.Second

type Server struct {
	Exec *exec.Manager
	// Outer runs exec.outer: an exec in the agent's own world, as root
	Outer    *exec.Manager
	Sessions *session.Manager
	Services *services.Supervisor
	Listen   *listen.Manager
	Dial     *dial.Dialer
	// Files holds the read-only files the inner container sees
	Files *files.Store
	// Shutdown powers the guest off. It runs after the reply is sent.
	Shutdown func()
	// IdentityReset is what this boot's identity reset reported, or "".
	IdentityReset string
	// BootID is the guest's boot_id, for ping
	BootID string
	// Inner reports the inner container for ping; nil leaves it out
	Inner func() *proto.InnerStatus

	freezeMu  sync.Mutex
	thawTimer *time.Timer
	// freezeGen counts freezes and thaws. An auto-thaw timer only acts if
	// no freeze or thaw happened since it was armed.
	freezeGen uint64
	frozen    bool
	// poweringOff refuses freezes once poweroff has thawed for good.
	poweringOff bool
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
	// A panic in a request drops its connection, not the agent.
	defer safe.Recover("request", nil)
	r, w := proto.NewReader(c), proto.NewWriter(c)

	_ = c.SetReadDeadline(time.Now().Add(requestTimeout))
	f, err := r.Next()
	_ = c.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	if f.Type != proto.TypeRequest {
		replyErr(w, proto.ErrBadRequest, "first frame must be REQUEST, got "+f.Type.String())
		return
	}
	req := &proto.Request{}
	if err := proto.Unmarshal(f.Payload, req); err != nil {
		replyErr(w, proto.ErrBadRequest, err.Error())
		return
	}

	if req.Op == proto.OpSessionAttach || req.Op == proto.OpSessionTap || (req.Op == proto.OpExec && req.GetSession() != "") {
		if err := s.Sessions.Serve(req, c, r, w); err != nil {
			log.Printf("session %s: %v", req.GetSession(), err)
		}
		return
	}
	if req.Op == proto.OpExec {
		if err := s.Exec.Serve(req, r, w); err != nil {
			log.Printf("exec: %v", err)
		}
		return
	}
	if req.Op == proto.OpExecOuter {
		if err := s.serveOuter(req, r, w); err != nil {
			log.Printf("exec.outer: %v", err)
		}
		return
	}
	if req.Op == proto.OpDial {
		if err := s.Dial.Serve(req, r, w); err != nil {
			log.Printf("dial %s %s: %v", req.GetNetwork(), req.GetAddress(), err)
		}
		return
	}
	// agent.listen and listen are long-lived but run nothing, so they are
	// not execs in the activity report
	if req.Op == proto.OpAgentListen {
		if err := s.Listen.ServeAgent(r, w); err != nil {
			log.Printf("agent.listen: %v", err)
		}
		return
	}
	if req.Op == proto.OpListen {
		if err := s.Listen.Serve(req, r, w); err != nil {
			log.Printf("listen %s %s: %v", req.GetNetwork(), req.GetAddress(), err)
		}
		return
	}
	if req.Op == proto.OpAgentAccept {
		if err := s.Listen.Accept(req, r, w); err != nil {
			log.Printf("agent.accept: %v", err)
		}
		return
	}
	if req.Op == proto.OpServicesLogs {
		s.serveLogs(req, r, w)
		return
	}
	resp, err := s.safeUnary(req)
	if err != nil {
		var pe *proto.Error
		if !errors.As(err, &pe) {
			pe = &proto.Error{Code: proto.ErrInternal, Message: err.Error()}
		}
		w.WriteMessage(proto.TypeResponse, &proto.ErrorResponse{Error: pe})
		return
	}
	w.WriteMessage(proto.TypeResponse, resp)
	if req.Op == proto.OpShutdown {
		c.Close()
		s.Shutdown()
	}
}

// safeUnary runs unary and turns a panic into an INTERNAL reply.
func (s *Server) safeUnary(req *proto.Request) (resp protoreflect.ProtoMessage, err error) {
	defer safe.Recover("request "+req.Op, func() {
		resp, err = nil, &proto.Error{Code: proto.ErrInternal, Message: "agent panic in " + req.Op}
	})
	return s.unary(req)
}

func (s *Server) unary(req *proto.Request) (protoreflect.ProtoMessage, error) {
	switch req.Op {
	case proto.OpPing:
		ping := BuildPing(unix.ClockGettime)
		if s.IdentityReset != "" {
			ping.IdentityReset = new(s.IdentityReset)
		}
		if s.BootID != "" {
			ping.BootId = new(s.BootID)
		}
		if s.Inner != nil {
			ping.Inner = s.Inner()
		}
		return ping, nil
	case proto.OpActivity:
		return s.activity()
	case proto.OpFreeze:
		return &proto.OK{Ok: true}, s.freeze(time.Duration(req.GetTimeoutMs()) * time.Millisecond)
	case proto.OpThaw:
		return &proto.OK{Ok: true}, s.thaw()
	case proto.OpResumed:
		if req.GetUnixMs() <= 0 {
			return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "unix_ms is required"}
		}
		ts := unix.NsecToTimespec(int64(req.GetUnixMs()) * int64(time.Millisecond))
		return &proto.OK{Ok: true}, unix.ClockSettime(unix.CLOCK_REALTIME, &ts)
	case proto.OpGrow:
		if req.GetDiskBytes() <= 0 {
			return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "disk_bytes is required"}
		}
		return &proto.OK{Ok: true}, s.grow(int64(req.GetDiskBytes()))
	case proto.OpServicesList:
		return &proto.ServicesList{Services: s.Services.List(), ImageUser: s.Services.ImageUser()}, nil
	case proto.OpServicesAdd:
		if req.Def == nil {
			return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "def is required"}
		}
		return &proto.OK{Ok: true}, s.Services.Add(req.Def, req.GetReplace())
	case proto.OpServicesRemove:
		return &proto.OK{Ok: true}, s.Services.Remove(req.GetService())
	case proto.OpServicesRestart:
		return &proto.OK{Ok: true}, s.Services.Restart(req.GetService())
	case proto.OpSessionKill:
		return &proto.OK{Ok: true}, s.Sessions.Kill(req.GetSession())
	case proto.OpFilesWrite:
		return &proto.OK{Ok: true}, s.Files.Write(req.GetPath(), req.GetData())
	case proto.OpFilesRemove:
		removed, err := s.Files.Remove(req.GetPath())
		return &proto.FilesRemoved{Removed: removed}, err
	case proto.OpShutdown:
		return &proto.OK{Ok: true}, nil
	default:
		return nil, &proto.Error{Code: proto.ErrUnknownOp, Message: "unknown op " + req.Op}
	}
}

// serveOuter runs an outer exec. It runs as root, and has no session: the
// agent's world has no accounts, and a session would outlive the caller.
func (s *Server) serveOuter(req *proto.Request, r *proto.Reader, w *proto.Writer) error {
	if req.GetSession() != "" {
		return w.WriteMessage(proto.TypeResponse, &proto.ErrorResponse{
			Error: &proto.Error{Code: proto.ErrBadRequest, Message: "an outer exec takes no session"},
		})
	}
	if req.GetUser() != "" && req.GetUser() != "root" && req.GetUser() != "0" {
		return w.WriteMessage(proto.TypeResponse, &proto.ErrorResponse{
			Error: &proto.Error{Code: proto.ErrBadRequest, Message: "an outer exec runs as root"},
		})
	}
	return s.Outer.Serve(req, r, w)
}

// serveLogs streams a service's log until it ends or the host closes the
// connection, which the host does to stop a follow.
func (s *Server) serveLogs(req *proto.Request, r *proto.Reader, w *proto.Writer) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, err := r.Next(); err != nil {
				return
			}
		}
	}()
	logReq := services.LogRequest{Lines: int(req.GetLines()), Follow: req.GetFollow(), Cursor: req.Cursor}
	err := s.Services.Logs(req.GetService(), logReq, w, done)
	var pe *proto.Error
	if errors.As(err, &pe) {
		w.WriteMessage(proto.TypeResponse, &proto.ErrorResponse{Error: pe})
	} else if err != nil {
		log.Printf("services.logs %s: %v", req.GetService(), err)
	}
}

func replyErr(w *proto.Writer, code, msg string) {
	w.WriteMessage(proto.TypeResponse, &proto.ErrorResponse{Error: &proto.Error{Code: code, Message: msg}})
}

// BuildPing reports the uptime from CLOCK_BOOTTIME, or none when the clock
// read fails: a 0 would make impd wait out a guest that is not young.
func BuildPing(clockGettime func(int32, *unix.Timespec) error) *proto.Ping {
	ping := &proto.Ping{Ok: true, Version: proto.Version}
	var ts unix.Timespec
	if clockGettime(unix.CLOCK_BOOTTIME, &ts) == nil {
		ping.UptimeMs = new(float64(ts.Nano() / int64(time.Millisecond)))
	}
	return ping
}
