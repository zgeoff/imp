// Package session keeps named programs on a pty alive without a host
// connection. A connection attaches as the session's one viewer: it gets a
// replay of recent output, then live output, and its input goes to the
// program. Closing the connection detaches; the program keeps running. See
// docs/architecture/protocol.md ("Sessions").
package session

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// MaxSessions bounds the sessions of one guest, exited ones that still hold
// an undelivered EXIT included.
const MaxSessions = 16

// killGrace is how long a killed session's process has between SIGHUP and
// SIGKILL.
const killGrace = 2 * time.Second

// namePattern is the session name rule; the host checks the same one.
var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

type Manager struct {
	launcher *launch.Launcher

	mu       sync.Mutex
	sessions map[string]*session

	// attached counts open session connections.
	attached atomic.Int64
}

func NewManager(l *launch.Launcher) *Manager {
	return &Manager{launcher: l, sessions: make(map[string]*session)}
}

// Attached returns the number of open session connections.
func (m *Manager) Attached() int { return int(m.attached.Load()) }

// List returns every session, sorted by name.
func (m *Manager) List() []proto.SessionInfo {
	m.mu.Lock()
	all := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	infos := make([]proto.SessionInfo, 0, len(all))
	for _, s := range all {
		infos = append(infos, s.info())
	}
	slices.SortFunc(infos, func(a, b proto.SessionInfo) int { return strings.Compare(a.Name, b.Name) })
	return infos
}

// Kill ends a session: its name is free at once, its process gets SIGHUP,
// then SIGKILL after killGrace. An attached viewer still gets the EXIT.
func (m *Manager) Kill(name string) error {
	m.mu.Lock()
	s, ok := m.sessions[name]
	if ok {
		delete(m.sessions, name)
	}
	m.mu.Unlock()
	if !ok {
		return noSession(name)
	}
	if s.exited() {
		return nil
	}
	s.proc.Signal(syscall.SIGHUP)
	safe.Go("session "+name+" kill", func() {
		select {
		case <-s.done:
		case <-time.After(killGrace):
			s.proc.Signal(syscall.SIGKILL)
		}
	}, nil)
	return nil
}

// Serve runs one session connection: exec with a session name (start the
// session, or attach to it if it runs) or session.attach. It returns when
// the connection ends; the caller closes it.
func (m *Manager) Serve(req proto.Request, conn net.Conn, r *proto.Reader, w *proto.Writer) error {
	m.attached.Add(1)
	defer m.attached.Add(-1)

	s, created, perr := m.find(req)
	if perr != nil {
		return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: perr})
	}
	v := newViewer(conn, w)
	safe.Go("session "+s.name+" writer", v.run, func() { conn.Close() })
	if !s.attach(v, req.Cols, req.Rows, created) {
		v.stop(nil, false)
		<-v.done
		return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: noSession(s.name)})
	}
	m.removeIfOver(s)

	input(s, v, r)
	s.detach(v)
	conn.Close()
	<-v.done
	return nil
}

// find returns the session req names. exec starts it unless it runs already;
// session.attach only finds it.
func (m *Manager) find(req proto.Request) (*session, bool, *proto.Error) {
	if !namePattern.MatchString(req.Session) {
		return nil, false, &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("bad session name %q", req.Session)}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[req.Session]
	if req.Op == proto.OpSessionAttach {
		if !ok {
			return nil, false, noSession(req.Session)
		}
		return s, false, nil
	}
	if !req.TTY {
		return nil, false, &proto.Error{Code: proto.ErrBadRequest, Message: "a session needs a tty"}
	}
	if ok && !s.exited() {
		return s, false, nil
	}
	// an exited session gives its name, and its slot, to the new one
	if !ok && len(m.sessions) >= MaxSessions {
		return nil, false, &proto.Error{Code: proto.ErrSessionCap, Message: fmt.Sprintf("this imp already has %d sessions", MaxSessions)}
	}
	p, master, err := m.launcher.StartPTY(req)
	if err != nil {
		return nil, false, &proto.Error{Code: proto.ErrExecFailed, Message: err.Error()}
	}
	s = newSession(req.Session, req, p, master)
	m.sessions[s.name] = s
	safe.Go("session "+s.name, func() { s.run(func() { m.removeIfOver(s) }) }, nil)
	return s, true, nil
}

// removeIfOver frees the name of a session whose EXIT a viewer got.
func (m *Manager) removeIfOver(s *session) {
	if !s.over() {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[s.name] == s {
		delete(m.sessions, s.name)
	}
}

// input applies the viewer's frames until the connection ends. It never
// signals the process on the way out: a closed connection is a detach.
func input(s *session, v *viewer, r *proto.Reader) {
	for {
		f, err := r.Next()
		if err != nil {
			return
		}
		switch f.Type {
		case proto.TypeStdin:
			s.queueStdin(v, f.Payload)
		case proto.TypeStdinEOF:
			// A tty has no EOF to give; the client sends ^D itself.
		case proto.TypeResize:
			var rs proto.Resize
			if json.Unmarshal(f.Payload, &rs) == nil {
				s.resize(v, rs.Cols, rs.Rows)
			}
		case proto.TypeSignal:
			var sig proto.Signal
			if json.Unmarshal(f.Payload, &sig) == nil && sig.Signal > 0 {
				s.signal(v, syscall.Signal(sig.Signal))
			}
		default:
			log.Printf("session %s: ignoring %s frame", s.name, f.Type)
		}
	}
}

func noSession(name string) *proto.Error {
	return &proto.Error{Code: proto.ErrNoSession, Message: fmt.Sprintf("no session %q", name)}
}
