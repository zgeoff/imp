// Package sshagent serves ssh-agent forwarding inside the guest. impd's SSH
// gateway opens an agent.listen connection for an SSH connection that asked
// for agent forwarding; the agent serves a unix socket for SSH_AUTH_SOCK
// until that connection ends. Each client of the socket is announced with a
// CONNECTION frame, and impd pairs it with an agent.accept connection that
// relays its bytes to the user's ssh-agent.
package sshagent

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
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/dial"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// Root holds one directory per listener. /run is a fresh tmpfs every boot,
// so a socket never outlives the boot it was made in.
const Root = "/run/imp/ssh-agent"

const (
	// maxPending bounds the clients that wait for impd's agent.accept; more
	// are closed at once
	maxPending = 16

	socketName = "agent.sock"
)

// pendingTimeout closes a client impd never paired. A variable for tests.
var pendingTimeout = 10 * time.Second

type Manager struct {
	root string

	// user owns the socket: the image's user, as exec runs commands
	user string

	mu        sync.Mutex
	listeners map[string]*listener
}

func NewManager(root, user string) *Manager {
	return &Manager{root: root, user: user, listeners: map[string]*listener{}}
}

type listener struct {
	id  string
	dir string
	uid uint32
	ln  *net.UnixListener
	w   *proto.Writer

	mu      sync.Mutex
	next    uint64
	pending map[uint64]*net.UnixConn
	closed  bool
}

// Listen serves an agent.listen connection: it makes the socket, replies
// with its path, then announces each client until the host closes the
// connection. The socket and its directory go with it.
func (m *Manager) Listen(r *proto.Reader, w *proto.Writer) error {
	l, err := m.open(w)
	if err != nil {
		return w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: &proto.Error{Code: proto.ErrInternal, Message: err.Error()}})
	}
	defer m.close(l)

	if err := w.WriteJSON(proto.TypeResponse, proto.AgentListen{OK: true, Path: filepath.Join(l.dir, socketName), Listener: l.id}); err != nil {
		return err
	}

	accepted := make(chan error, 1)
	safe.Go("ssh-agent accept", func() {
		accepted <- l.serve()
	}, func() {
		accepted <- errors.New("ssh-agent accept panicked")
	})

	// The host sends nothing more; its close, or a vsock reset after a
	// forced sleep, ends the listener.
	hostDone := make(chan error, 1)
	safe.Go("ssh-agent host", func() {
		hostDone <- drain(r)
	}, func() {
		hostDone <- errors.New("ssh-agent host reader panicked")
	})

	select {
	case err := <-hostDone:
		return err
	case err := <-accepted:
		return err
	}
}

// Accept serves an agent.accept connection: it takes the client the host
// named and relays it. A client already closed or timed out is NO_CONNECTION.
func (m *Manager) Accept(req proto.Request, r *proto.Reader, w *proto.Writer) error {
	m.mu.Lock()
	l := m.listeners[req.Listener]
	m.mu.Unlock()

	var c *net.UnixConn
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

// open makes the listener's directory and socket. Both are made as root and
// handed to the user last, so nobody else can reach the socket in between.
func (m *Manager) open(w *proto.Writer) (*listener, error) {
	cred, _, err := proc.LookupUser(m.user)
	if err != nil {
		return nil, err
	}
	uid, gid := uint32(0), uint32(0)
	if cred != nil {
		uid, gid = cred.Uid, cred.Gid
	}

	id, err := randomID()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(m.root, 0o755); err != nil {
		return nil, err
	}
	dir := filepath.Join(m.root, id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, err
	}

	l := &listener{id: id, dir: dir, uid: uid, w: w, pending: map[uint64]*net.UnixConn{}}
	if err := l.listen(gid); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}

	m.mu.Lock()
	m.listeners[id] = l
	m.mu.Unlock()
	return l, nil
}

func (l *listener) listen(gid uint32) error {
	path := filepath.Join(l.dir, socketName)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return err
	}
	// the directory goes as a whole when the listener closes
	ln.SetUnlinkOnClose(false)
	l.ln = ln

	for _, step := range []func() error{
		func() error { return os.Chmod(path, 0o600) },
		func() error { return os.Lchown(path, int(l.uid), int(gid)) },
		func() error { return os.Chown(l.dir, int(l.uid), int(gid)) },
	} {
		if err := step(); err != nil {
			ln.Close()
			return err
		}
	}
	return nil
}

// close ends the listener, its waiting clients and its directory. Relayed
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
	if err := os.RemoveAll(l.dir); err != nil {
		log.Printf("ssh-agent: remove %s: %v", l.dir, err)
	}
}

// serve accepts clients until the listener closes.
func (l *listener) serve() error {
	for {
		c, err := l.ln.AcceptUnix()
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		if err != nil {
			return err
		}
		if !l.allows(c) {
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

// allows checks the client's uid: the socket's owner, or root. The modes
// already keep others out; this holds even if a mode is changed.
func (l *listener) allows(c *net.UnixConn) bool {
	raw, err := c.SyscallConn()
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
func (l *listener) add(c *net.UnixConn) (uint64, bool) {
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

func (l *listener) take(id uint64) *net.UnixConn {
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
