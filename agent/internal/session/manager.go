// Package session keeps named programs on a pty alive without a host
// connection. A connection attaches as the session's one viewer: it gets a
// replay of recent output, then live output, and its input goes to the
// program. Closing the connection detaches; the program keeps running. See
// docs/architecture/protocol.md#sessions.
package session

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	"github.com/zgeoff/imp/agent/internal/proc"
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
	// bootID is the guest's boot_id, which every session's output names
	bootID string

	// starting serializes starts, so a spawn needs no hold on mu, which List
	// and Kill take. It guards seq too.
	starting sync.Mutex
	seq      uint64
	mu       sync.Mutex
	sessions map[string]*session
	// previous holds, per name, the last generation that ended and left
	// the name, for at most MaxSessions names
	previous map[string]ended

	// attached counts open session connections.
	attached atomic.Int64
}

// ended is a generation in previous, with its place among the runs.
type ended struct {
	seq      uint64
	previous proto.Previous
}

func NewManager(l *launch.Launcher, bootID string) *Manager {
	return &Manager{launcher: l, bootID: bootID, sessions: make(map[string]*session), previous: make(map[string]ended)}
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
		return m.noSession(name)
	}
	m.retire(s)
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

	v := newViewer(conn, w)
	safe.Go("session "+req.Session+" writer", v.run, func() { conn.Close() })
	s, perr := m.attach(req, v)
	if perr != nil {
		v.stop(nil, false)
		<-v.done
		return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: perr})
	}

	input(s, v, r)
	s.detach(v)
	conn.Close()
	<-v.done
	return nil
}

// attach finds the session req names and makes v its viewer. A start that
// finds the session over between its look and the attach (a viewer got the
// EXIT meanwhile) looks again, and then replaces it.
func (m *Manager) attach(req proto.Request, v *viewer) (*session, *proto.Error) {
	for range 2 {
		s, created, perr := m.find(req)
		if perr != nil {
			return nil, perr
		}
		err := s.attach(v, req.Cols, req.Rows, created, req.ResumeFrom, m.previousOf(s.name))
		if err == nil {
			return s, nil
		}
		if !errors.Is(err, errOver) {
			return nil, err.(*proto.Error)
		}
		if req.Op != proto.OpExec {
			break
		}
	}
	return nil, m.noSession(req.Session)
}

// find returns the session req names. exec starts it unless it runs
// already, or a resume names its generation, which exited but whose EXIT
// no viewer got yet; session.attach only finds it.
func (m *Manager) find(req proto.Request) (*session, bool, *proto.Error) {
	if !namePattern.MatchString(req.Session) {
		return nil, false, &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("bad session name %q", req.Session)}
	}
	if req.Op == proto.OpSessionAttach {
		m.mu.Lock()
		s, ok := m.sessions[req.Session]
		m.mu.Unlock()
		if !ok {
			return nil, false, m.noSession(req.Session)
		}
		return s, false, nil
	}
	if !req.TTY {
		return nil, false, &proto.Error{Code: proto.ErrBadRequest, Message: "a session needs a tty"}
	}
	m.starting.Lock()
	defer m.starting.Unlock()
	m.mu.Lock()
	s, ok := m.sessions[req.Session]
	count := len(m.sessions)
	m.mu.Unlock()
	if ok && (!s.exited() || isResumeOf(req.ResumeFrom, s) && !s.over()) {
		return s, false, nil
	}
	// an exited session gives its name, and its slot, to the new one. Its
	// exit is set just before done closes: wait for that, so the new
	// session's STARTED names it as previous.
	if ok {
		<-s.done
		m.retire(s)
	}
	if !ok && count >= MaxSessions {
		return nil, false, &proto.Error{Code: proto.ErrSessionCap, Message: fmt.Sprintf("this imp already has %d sessions", MaxSessions)}
	}
	p, master, err := m.launcher.StartPTY(req, nil)
	if err != nil {
		return nil, false, proto.StartError(err, errors.Is(err, proc.ErrDown))
	}
	m.seq++
	s = newSession(req.Session, req, run{proc: p, master: master, generation: newGeneration(), seq: m.seq, bootID: m.bootID})
	s.onDelivered = func() { m.removeIfOver(s) }
	m.mu.Lock()
	m.sessions[s.name] = s
	m.mu.Unlock()
	safe.Go("session "+s.name, s.run, nil)
	return s, true, nil
}

// removeIfOver frees the name of a session whose EXIT a viewer got.
func (m *Manager) removeIfOver(s *session) {
	if !s.over() {
		return
	}
	m.mu.Lock()
	current := m.sessions[s.name] == s
	if current {
		delete(m.sessions, s.name)
	}
	m.mu.Unlock()
	if current {
		m.retire(s)
	}
}

// retire records s as its name's previous generation once its process has
// ended, so the end and exit it records are final. s has left the name.
func (m *Manager) retire(s *session) {
	select {
	case <-s.done:
		m.record(s)
	default:
		safe.Go("session "+s.name+" retire", func() {
			<-s.done
			m.record(s)
		}, nil)
	}
}

// record keeps s as previous unless a later run of the name is there
// already, as when a killed process outlives its replacement.
func (m *Manager) record(s *session) {
	e := ended{seq: s.seq, previous: s.ended()}
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.previous[s.name]; ok && cur.seq > e.seq {
		return
	}
	m.previous[s.name] = e
	if len(m.previous) <= MaxSessions {
		return
	}
	oldest := s.name
	for name, other := range m.previous {
		if other.seq < m.previous[oldest].seq {
			oldest = name
		}
	}
	delete(m.previous, oldest)
}

// previousOf returns the name's previous generation, or nil.
func (m *Manager) previousOf(name string) *proto.Previous {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.previous[name]; ok {
		return &e.previous
	}
	return nil
}

func (m *Manager) noSession(name string) *proto.Error {
	return &proto.Error{
		Code:    proto.ErrNoSession,
		Message: fmt.Sprintf("no session %q", name),
		Data:    proto.NoSessionData{BootID: m.bootID, Previous: m.previousOf(name)},
	}
}

// isResumeOf reports whether a resume names s's generation.
func isResumeOf(resume *proto.ResumeFrom, s *session) bool {
	return resume != nil && resume.Generation == s.generation
}

// newGeneration returns 16 random bytes as 32 lowercase hex characters.
func newGeneration() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
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
