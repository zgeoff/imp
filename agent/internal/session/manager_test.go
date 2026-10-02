package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

// The reaper runs a process-wide wait4 loop, so the package shares one.
var testReaper *reaper.Reaper

func TestMain(m *testing.M) {
	testReaper = reaper.New()
	os.Exit(m.Run())
}

func newTestManager(t *testing.T) *Manager {
	m := NewManager(launch.New(testReaper, imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}))
	t.Cleanup(func() {
		for _, s := range m.List() {
			m.Kill(s.Name)
			syscall.Kill(-s.Pid, syscall.SIGKILL)
		}
	})
	return m
}

// host is the host side of one session connection.
type host struct {
	conn   net.Conn
	w      *proto.Writer
	frames chan proto.Frame
	served chan error
	out    bytes.Buffer
}

func connect(t *testing.T, m *Manager, req proto.Request) *host {
	t.Helper()
	guest, conn := net.Pipe()
	return serve(t, m, req, guest, conn)
}

func serve(t *testing.T, m *Manager, req proto.Request, guest, conn net.Conn) *host {
	t.Helper()
	h := &host{conn: conn, w: proto.NewWriter(conn), frames: make(chan proto.Frame, 1024), served: make(chan error, 1)}
	go func() {
		h.served <- m.Serve(req, guest, proto.NewReader(guest), proto.NewWriter(guest))
		guest.Close()
	}()
	go func() {
		defer close(h.frames)
		r := proto.NewReader(conn)
		for {
			f, err := r.Next()
			if err != nil {
				return
			}
			h.frames <- f
		}
	}()
	t.Cleanup(func() { conn.Close() })
	return h
}

func start(t *testing.T, m *Manager, name, script string) *host {
	t.Helper()
	return connect(t, m, proto.Request{Op: proto.OpExec, Session: name, TTY: true,
		Argv: []string{"sh", "-c", script}, Cols: 80, Rows: 24})
}

func attach(t *testing.T, m *Manager, name string) *host {
	t.Helper()
	return connect(t, m, proto.Request{Op: proto.OpSessionAttach, Session: name, Cols: 80, Rows: 24})
}

func (h *host) next(t *testing.T) proto.Frame {
	t.Helper()
	select {
	case f, ok := <-h.frames:
		if !ok {
			t.Fatal("connection closed")
		}
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("no frame within 5s")
		return proto.Frame{}
	}
}

func (h *host) started(t *testing.T) proto.Started {
	t.Helper()
	f := h.next(t)
	if f.Type != proto.TypeStarted {
		t.Fatalf("first frame %s %q, want STARTED", f.Type, f.Payload)
	}
	var st proto.Started
	if err := json.Unmarshal(f.Payload, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// until reads output until it contains want, and fails on any other frame.
func (h *host) until(t *testing.T, want string) {
	t.Helper()
	for !strings.Contains(h.out.String(), want) {
		f := h.next(t)
		if f.Type != proto.TypeStdout {
			t.Fatalf("got %s %q while waiting for %q in %q", f.Type, f.Payload, want, h.out.String())
		}
		h.out.Write(f.Payload)
	}
}

// last reads to the frame that ends the connection: EXIT or DETACHED.
func (h *host) last(t *testing.T) proto.Frame {
	t.Helper()
	for {
		f := h.next(t)
		switch f.Type {
		case proto.TypeStdout:
			h.out.Write(f.Payload)
		case proto.TypeExit, proto.TypeDetached:
			return f
		default:
			t.Fatalf("unexpected %s frame", f.Type)
		}
	}
}

func (h *host) errorCode(t *testing.T) string {
	t.Helper()
	f := h.next(t)
	var resp proto.ErrorResponse
	if f.Type != proto.TypeResponse || json.Unmarshal(f.Payload, &resp) != nil || resp.Error == nil {
		t.Fatalf("got %s %q, want an error RESPONSE", f.Type, f.Payload)
	}
	return resp.Error.Code
}

func (h *host) send(t *testing.T, typ proto.Type, payload []byte) {
	t.Helper()
	if err := h.w.Write(typ, payload); err != nil {
		t.Fatal(err)
	}
}

func (h *host) detach(t *testing.T) {
	t.Helper()
	h.conn.Close()
	select {
	case <-h.served:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after the host closed")
	}
}

func decode[T any](t *testing.T, f proto.Frame) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(f.Payload, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func find(m *Manager, name string) (proto.SessionInfo, bool) {
	for _, s := range m.List() {
		if s.Name == name {
			return s, true
		}
	}
	return proto.SessionInfo{}, false
}

func TestDetachLeavesTheProcessRunning(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `trap 'echo got-hup' HUP; echo ready; while read l; do echo "said $l"; done`)
	st := h.started(t)
	if !st.Created || st.Session != "main" {
		t.Fatalf("STARTED %+v, want a new session main", st)
	}
	h.until(t, "ready")
	if m.Attached() != 1 {
		t.Fatalf("Attached() = %d, want 1", m.Attached())
	}
	h.detach(t)

	info, ok := find(m, "main")
	if !ok || info.State != proto.SessionRunning || info.Attached {
		t.Fatalf("after detach: %+v, %v", info, ok)
	}
	if syscall.Kill(st.Pid, 0) != nil {
		t.Fatal("the process is gone")
	}
	if m.Attached() != 0 {
		t.Fatalf("Attached() = %d, want 0", m.Attached())
	}

	again := attach(t, m, "main")
	st2 := again.started(t)
	if st2.Created || st2.Pid != st.Pid {
		t.Fatalf("STARTED %+v, want pid %d attached", st2, st.Pid)
	}
	// the replay: what the session wrote while the first viewer watched
	again.until(t, "ready")
	again.send(t, proto.TypeStdin, []byte("hello\n"))
	again.until(t, "said hello")
	if strings.Contains(again.out.String(), "got-hup") {
		t.Fatal("the detach sent SIGHUP")
	}
}

func TestReattachRedraws(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `trap 'echo winch-$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)

	// the same size: the session still sees a resize
	same := attach(t, m, "main")
	same.started(t)
	same.until(t, "winch-24 80")
	same.detach(t)

	wide := connect(t, m, proto.Request{Op: proto.OpSessionAttach, Session: "main", Cols: 120, Rows: 40})
	wide.started(t)
	wide.until(t, "winch-40 120")
	if info, _ := find(m, "main"); info.Cols != 120 || info.Rows != 40 {
		t.Fatalf("size %dx%d, want 120x40", info.Cols, info.Rows)
	}
}

func TestTakeover(t *testing.T) {
	m := newTestManager(t)
	first := start(t, m, "main", `echo ready; while read l; do echo "said $l"; done`)
	first.started(t)
	first.until(t, "ready")

	second := attach(t, m, "main")
	second.started(t)
	f := first.last(t)
	if f.Type != proto.TypeDetached || decode[proto.Detached](t, f).Reason != proto.DetachTakenOver {
		t.Fatalf("first viewer got %s %q, want DETACHED taken_over", f.Type, f.Payload)
	}
	select {
	case <-first.served:
	case <-time.After(5 * time.Second):
		t.Fatal("the first connection stayed open")
	}
	second.send(t, proto.TypeStdin, []byte("hi\n"))
	second.until(t, "said hi")
}

// A viewer whose host stopped reading, but never closed, does not keep a
// new viewer out.
func TestTakeoverOfAHalfOpenViewer(t *testing.T) {
	m := newTestManager(t)
	guest, conn := net.Pipe()
	stuck := &host{conn: conn, served: make(chan error, 1)}
	go func() {
		stuck.served <- m.Serve(proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"sh", "-c", "echo ready; while read l; do echo \"said $l\"; done"}}, guest, proto.NewReader(guest), proto.NewWriter(guest))
	}()
	t.Cleanup(func() { conn.Close() })
	waitFor(t, "the session", func() bool { _, ok := find(m, "main"); return ok })

	second := attach(t, m, "main")
	second.started(t)
	second.until(t, "ready")
	second.send(t, proto.TypeStdin, []byte("hi\n"))
	second.until(t, "said hi")
}

func TestExitWhileDetached(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `read go; echo bye; exit 3`)
	h.started(t)
	h.send(t, proto.TypeStdin, []byte("go\n"))
	h.detach(t)

	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })
	info, _ := find(m, "job")
	if info.Exit == nil || info.Exit.Code != 3 {
		t.Fatalf("exit %+v, want code 3", info.Exit)
	}

	later := attach(t, m, "job")
	later.started(t)
	f := later.last(t)
	if f.Type != proto.TypeExit || decode[proto.Exit](t, f).Code != 3 {
		t.Fatalf("got %s %q, want EXIT 3", f.Type, f.Payload)
	}
	if !strings.Contains(later.out.String(), "bye") {
		t.Fatalf("replay %q lost the last output", later.out.String())
	}
	if _, ok := find(m, "job"); ok {
		t.Fatal("the session is still listed after its EXIT was delivered")
	}
	if code := attach(t, m, "job").errorCode(t); code != proto.ErrNoSession {
		t.Fatalf("attach after the EXIT: %s, want NO_SESSION", code)
	}
}

func TestExitWhileAttached(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `echo bye; exit 4`)
	h.started(t)
	f := h.last(t)
	if f.Type != proto.TypeExit || decode[proto.Exit](t, f).Code != 4 {
		t.Fatalf("got %s %q, want EXIT 4", f.Type, f.Payload)
	}
	waitFor(t, "the session to go", func() bool { _, ok := find(m, "job"); return !ok })
}

func TestKill(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `echo ready; sleep 30`)
	h.started(t)
	h.until(t, "ready")
	if err := m.Kill("main"); err != nil {
		t.Fatal(err)
	}
	f := h.last(t)
	if exit := decode[proto.Exit](t, f); f.Type != proto.TypeExit || exit.Signal != int(syscall.SIGHUP) {
		t.Fatalf("got %s %q, want EXIT by SIGHUP", f.Type, f.Payload)
	}
	var pe *proto.Error
	if err := m.Kill("main"); !errors.As(err, &pe) || pe.Code != proto.ErrNoSession {
		t.Fatalf("second kill: %v, want NO_SESSION", err)
	}
}

func TestKillEscalates(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `trap "" HUP; echo ready; while :; do sleep 0.05; done`)
	h.started(t)
	h.until(t, "ready")
	m.Kill("main")
	f := h.last(t)
	if exit := decode[proto.Exit](t, f); exit.Signal != int(syscall.SIGKILL) {
		t.Fatalf("got %+v, want SIGKILL", exit)
	}
}

func TestBadRequests(t *testing.T) {
	m := newTestManager(t)
	tests := []struct {
		name string
		req  proto.Request
		code string
	}{
		{"no tty", proto.Request{Op: proto.OpExec, Session: "main", Argv: []string{"true"}}, proto.ErrBadRequest},
		{"bad name", proto.Request{Op: proto.OpExec, Session: "Main", TTY: true, Argv: []string{"true"}}, proto.ErrBadRequest},
		{"long name", proto.Request{Op: proto.OpExec, Session: strings.Repeat("a", 33), TTY: true, Argv: []string{"true"}}, proto.ErrBadRequest},
		{"no such program", proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"no-such-program"}}, proto.ErrExecFailed},
		{"attach to nothing", proto.Request{Op: proto.OpSessionAttach, Session: "none"}, proto.ErrNoSession},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code := connect(t, m, tt.req).errorCode(t); code != tt.code {
				t.Fatalf("code %s, want %s", code, tt.code)
			}
		})
	}
	if n := len(m.List()); n != 0 {
		t.Fatalf("%d sessions after failed requests", n)
	}
}

func TestSessionLimit(t *testing.T) {
	m := newTestManager(t)
	// exited sessions whose EXIT nobody got count too
	for i := range MaxSessions {
		script := "sleep 30"
		if i == 0 {
			script = "exit 0"
		}
		h := start(t, m, fmt.Sprintf("s%d", i), script)
		h.started(t)
		h.detach(t)
	}
	waitFor(t, "s0 to exit", func() bool { info, _ := find(m, "s0"); return info.State == proto.SessionExited })

	if code := start(t, m, "extra", "sleep 30").errorCode(t); code != proto.ErrSessionCap {
		t.Fatalf("code %s, want SESSION_LIMIT", code)
	}
	// the name of an exited session is free: a new session replaces it
	h := start(t, m, "s0", "echo fresh; sleep 30")
	if st := h.started(t); !st.Created {
		t.Fatal("the exited session was attached, not replaced")
	}
	h.until(t, "fresh")
	// a running session is attached, not replaced
	again := start(t, m, "s1", "echo other")
	if st := again.started(t); st.Created {
		t.Fatal("a running session was replaced")
	}
}

// A viewer that stops reading is dropped; the program and the session go on.
func TestSlowViewerIsDropped(t *testing.T) {
	m := newTestManager(t)
	guest, conn := net.Pipe()
	slow := &host{conn: conn, w: proto.NewWriter(conn), served: make(chan error, 1)}
	go func() {
		slow.served <- m.Serve(proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"sh", "-c", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"}}, guest, proto.NewReader(guest), proto.NewWriter(guest))
	}()
	t.Cleanup(func() { conn.Close() })
	waitFor(t, "the viewer to be dropped", func() bool { info, ok := find(m, "main"); return ok && !info.Attached })

	// the pump still runs: a new viewer gets live output
	fresh := attach(t, m, "main")
	fresh.started(t)
	for range 50 {
		if f := fresh.next(t); f.Type != proto.TypeStdout {
			t.Fatalf("got %s, want STDOUT", f.Type)
		}
	}

	// the slow viewer, once it reads again, finds DETACHED slow at the end
	r := proto.NewReader(conn)
	for {
		f, err := r.Next()
		if err != nil {
			t.Fatalf("connection ended without DETACHED: %v", err)
		}
		if f.Type == proto.TypeDetached {
			if reason := decode[proto.Detached](t, f).Reason; reason != proto.DetachSlow {
				t.Fatalf("reason %q, want slow", reason)
			}
			break
		}
	}
}

// failingConn fails every write after STARTED and the replay, like a host
// that went away without a close.
type failingConn struct {
	net.Conn
	writes atomic.Int64
}

func (c *failingConn) Write(b []byte) (int, error) {
	if c.writes.Add(1) > 2 {
		return 0, errors.New("broken")
	}
	return c.Conn.Write(b)
}

func TestFailedWriteEndsOnlyThatViewer(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `echo ready; while read l; do echo "said $l"; done`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)

	guest, conn := net.Pipe()
	broken := serve(t, m, proto.Request{Op: proto.OpSessionAttach, Session: "main"}, &failingConn{Conn: guest}, conn)
	broken.started(t)
	broken.send(t, proto.TypeStdin, []byte("a\nb\nc\nd\n"))
	select {
	case <-broken.served:
	case <-time.After(5 * time.Second):
		t.Fatal("the broken viewer stayed attached")
	}

	fresh := attach(t, m, "main")
	fresh.started(t)
	fresh.send(t, proto.TypeStdin, []byte("e\n"))
	fresh.until(t, "said e")
}
