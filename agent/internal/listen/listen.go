// Package listen serves sockets in the guest whose clients are relayed back
// to the host: ssh-agent forwarding (agent.listen) and reverse forwards
// (listen). The host keeps a control connection open for as long as the
// socket should live; the agent announces each client with a CONNECTION
// frame, and the host pairs it with an agent.accept connection that relays
// its bytes.
package listen

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/dial"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// The roots of the sockets the agent makes itself, one directory per
// listener. /run is a fresh tmpfs every boot, so a socket never outlives the
// boot it was made in.
const (
	AgentRoot   = "/run/imp/ssh-agent"
	ForwardRoot = "/run/imp/forward"
)

const (
	// maxPending bounds the clients that wait for impd's agent.accept; more
	// are closed at once
	maxPending = 16

	agentSocket   = "agent.sock"
	forwardSocket = "sock"
)

// pendingTimeout closes a client impd never paired. A variable for tests.
var pendingTimeout = 10 * time.Second

// Binder binds a socket as the image's user: dial.Dialer.
type Binder interface {
	Listen(network, address string) (*dial.Bound, error)
}

type Manager struct {
	agentRoot, forwardRoot string

	// user owns the sockets: the image's user, as exec runs commands
	user   string
	binder Binder

	mu        sync.Mutex
	listeners map[string]*listener
}

func NewManager(agentRoot, forwardRoot, user string, binder Binder) *Manager {
	return &Manager{
		agentRoot:   agentRoot,
		forwardRoot: forwardRoot,
		user:        user,
		binder:      binder,
		listeners:   map[string]*listener{},
	}
}

type listener struct {
	id string
	ln net.Listener
	w  *proto.Writer

	// a unix client must be the socket's user or root; a TCP port is open
	// to every process in the guest, as an sshd remote forward is
	checkPeer bool
	uid       uint32

	// removes what the listener made
	cleanup func()

	mu      sync.Mutex
	next    uint64
	pending map[uint64]net.Conn
	closed  bool
}

// ServeAgent serves an agent.listen connection: a socket for SSH_AUTH_SOCK
// in a directory of its own.
func (m *Manager) ServeAgent(r *proto.Reader, w *proto.Writer) error {
	return m.serve(r, w, func(l *listener) (proto.Listening, error) {
		return m.openOwn(l, m.agentRoot, agentSocket)
	})
}

// Serve serves a listen connection: a unix socket at the path asked for, or
// in a directory of its own for no path, or a port on 127.0.0.1.
func (m *Manager) Serve(req proto.Request, r *proto.Reader, w *proto.Writer) error {
	switch {
	case req.Network == "unix" && req.Address == "":
		return m.serve(r, w, func(l *listener) (proto.Listening, error) {
			return m.openOwn(l, m.forwardRoot, forwardSocket)
		})
	case req.Network == "unix" || req.Network == "tcp":
		return m.serve(r, w, func(l *listener) (proto.Listening, error) {
			return m.openBound(l, req.Network, req.Address)
		})
	default:
		return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: &proto.Error{
			Code:    proto.ErrBadRequest,
			Message: fmt.Sprintf("network must be tcp or unix, got %q", req.Network),
		}})
	}
}

// serve opens a listener, replies with where it listens, then announces each
// client until the host closes the connection. What it made goes with it.
func (m *Manager) serve(r *proto.Reader, w *proto.Writer, open func(*listener) (proto.Listening, error)) error {
	id, err := randomID()
	if err != nil {
		return replyErr(w, err)
	}
	l := &listener{id: id, w: w, pending: map[uint64]net.Conn{}}
	resp, err := open(l)
	if err != nil {
		return replyErr(w, err)
	}
	m.mu.Lock()
	m.listeners[id] = l
	m.mu.Unlock()
	defer m.close(l)

	resp.OK, resp.Listener = true, id
	if err := w.WriteJSON(proto.TypeResponse, resp); err != nil {
		return err
	}

	accepted := make(chan error, 1)
	safe.Go("listen accept", func() {
		accepted <- l.serve()
	}, func() {
		accepted <- errors.New("listen accept panicked")
	})

	// The host sends nothing more; its close, or a vsock reset after a
	// forced sleep, ends the listener.
	hostDone := make(chan error, 1)
	safe.Go("listen host", func() {
		hostDone <- drain(r)
	}, func() {
		hostDone <- errors.New("listen host reader panicked")
	})

	select {
	case err := <-hostDone:
		return err
	case err := <-accepted:
		return err
	}
}

func replyErr(w *proto.Writer, err error) error {
	var pe *proto.Error
	if !errors.As(err, &pe) {
		pe = &proto.Error{Code: proto.ErrInternal, Message: err.Error()}
	}
	return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: pe})
}

// Accept serves an agent.accept connection: it takes the client the host
// named and relays it. A client already closed or timed out is NO_CONNECTION.
func (m *Manager) Accept(req proto.Request, r *proto.Reader, w *proto.Writer) error {
	m.mu.Lock()
	l := m.listeners[req.Listener]
	m.mu.Unlock()

	var c net.Conn
	if l != nil {
		c = l.take(req.Connection)
	}
	if c == nil {
		return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: &proto.Error{
			Code:    proto.ErrNoConnection,
			Message: fmt.Sprintf("no waiting connection %d on listener %q", req.Connection, req.Listener),
		}})
	}
	defer c.Close()
	if err := w.WriteJSON(proto.TypeResponse, proto.OK{OK: true}); err != nil {
		return err
	}
	return dial.Relay(c, r, w)
}

func (m *Manager) lookupUser() (uid, gid uint32, err error) {
	cred, _, err := proc.LookupUser(m.user)
	if err != nil {
		return 0, 0, err
	}
	if cred == nil {
		return 0, 0, nil
	}
	return cred.Uid, cred.Gid, nil
}

// openOwn makes a directory under root and a socket in it. Both are made as
// root and handed to the user last, so nobody else can reach the socket in
// between.
func (m *Manager) openOwn(l *listener, root, name string) (proto.Listening, error) {
	uid, gid, err := m.lookupUser()
	if err != nil {
		return proto.Listening{}, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return proto.Listening{}, err
	}
	dir := filepath.Join(root, l.id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return proto.Listening{}, err
	}
	path := filepath.Join(dir, name)
	ln, err := listenOwn(path, dir, uid, gid)
	if err != nil {
		os.RemoveAll(dir)
		return proto.Listening{}, err
	}
	l.ln, l.checkPeer, l.uid = ln, true, uid
	// the directory goes as a whole when the listener closes
	l.cleanup = func() {
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("listen: remove %s: %v", dir, err)
		}
	}
	return proto.Listening{Path: path}, nil
}

func listenOwn(path, dir string, uid, gid uint32) (net.Listener, error) {
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(false)
	for _, step := range []func() error{
		func() error { return os.Chmod(path, 0o600) },
		func() error { return os.Lchown(path, int(uid), int(gid)) },
		func() error { return os.Chown(dir, int(uid), int(gid)) },
	} {
		if err := step(); err != nil {
			ln.Close()
			return nil, err
		}
	}
	return ln, nil
}

// openBound binds network and address as the image's user.
func (m *Manager) openBound(l *listener, network, address string) (proto.Listening, error) {
	uid, _, err := m.lookupUser()
	if err != nil {
		return proto.Listening{}, err
	}
	b, err := m.binder.Listen(network, address)
	if err != nil {
		return proto.Listening{}, err
	}
	l.ln, l.checkPeer, l.uid = b.Listener, network == "unix", uid
	l.cleanup = b.Close
	if network == "tcp" {
		return proto.Listening{Port: b.Port}, nil
	}
	return proto.Listening{Path: filepath.Clean(address)}, nil
}

// close ends the listener, its waiting clients and what it made. Relayed
// clients end with their own agent.accept connections.
func (m *Manager) close(l *listener) {
	m.mu.Lock()
	delete(m.listeners, l.id)
	m.mu.Unlock()

	l.mu.Lock()
	l.closed = true
	for id, c := range l.pending {
		c.Close()
		delete(l.pending, id)
	}
	l.mu.Unlock()

	l.ln.Close()
	l.cleanup()
}

// serve accepts clients until the listener closes.
func (l *listener) serve() error {
	for {
		c, err := l.ln.Accept()
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		if err != nil {
			return err
		}
		if l.checkPeer && !l.allows(c) {
			c.Close()
			continue
		}
		id, ok := l.add(c)
		if !ok {
			c.Close()
			continue
		}
		if err := l.w.WriteJSON(proto.TypeConnection, proto.Connection{ID: id}); err != nil {
			return err
		}
	}
}

// allows checks a unix client's uid: the socket's owner, or root. The modes
// already keep others out; this holds even if a mode is changed.
func (l *listener) allows(c net.Conn) bool {
	sc, ok := c.(syscall.Conn)
	if !ok {
		return false
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		return false
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil || credErr != nil {
		return false
	}
	return cred.Uid == l.uid || cred.Uid == 0
}

// add parks a client for agent.accept, unless maxPending already wait.
func (l *listener) add(c net.Conn) (uint64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || len(l.pending) >= maxPending {
		return 0, false
	}
	l.next++
	id := l.next
	l.pending[id] = c
	time.AfterFunc(pendingTimeout, func() {
		if c := l.take(id); c != nil {
			c.Close()
		}
	})
	return id, true
}

func (l *listener) take(id uint64) net.Conn {
	l.mu.Lock()
	defer l.mu.Unlock()
	c := l.pending[id]
	delete(l.pending, id)
	return c
}

// drain reads the host connection until it closes; nil for a clean close.
func drain(r *proto.Reader) error {
	for {
		if _, err := r.Next(); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func randomID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
