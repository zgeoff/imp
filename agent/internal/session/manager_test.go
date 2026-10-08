package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proc"
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
	t.Helper()
	m := NewManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil), testBootID)
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
	t.Cleanup(func() { conn.Close() })
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
		assert.Assert(t, ok, "connection closed")
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("no frame within 5s")
		return proto.Frame{}
	}
}

func (h *host) started(t *testing.T) proto.Started {
	t.Helper()
	f := h.next(t)
	assert.Equal(t, f.Type, proto.TypeStarted, "first frame %q", f.Payload)
	return decode[proto.Started](t, f)
}

// until reads output until it contains want, and fails on any other frame.
func (h *host) until(t *testing.T, want string) {
	t.Helper()
	for !strings.Contains(h.out.String(), want) {
		f := h.next(t)
		assert.Equal(t, f.Type, proto.TypeStdout, "frame %q while waiting for %q in %q", f.Payload, want, h.out.String())
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
	assert.Equal(t, f.Type, proto.TypeResponse, "frame %q", f.Payload)
	resp := decode[proto.ErrorResponse](t, f)
	assert.Assert(t, resp.Error != nil, "RESPONSE %q is no error", f.Payload)
	return resp.Error.Code
}

func (h *host) send(t *testing.T, typ proto.Type, payload []byte) {
	t.Helper()
	assert.NilError(t, h.w.Write(typ, payload))
}

func (h *host) detach(t *testing.T) {
	t.Helper()
	h.conn.Close()
	h.waitServed(t)
}

// waitServed waits for the guest side's Serve to return.
func (h *host) waitServed(t *testing.T) {
	t.Helper()
	select {
	case <-h.served:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return")
	}
}

func decode[T any](t *testing.T, f proto.Frame) T {
	t.Helper()
	var v T
	assert.NilError(t, json.Unmarshal(f.Payload, &v), "%s frame %q", f.Type, f.Payload)
	return v
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if ok() {
			return poll.Success()
		}
		return poll.Continue("waiting for %s", what)
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))
}

func find(m *Manager, name string) (proto.SessionInfo, bool) {
	for _, s := range m.List() {
		if s.Name == name {
			return s, true
		}
	}
	return proto.SessionInfo{}, false
}

func TestServeStartsANewSessionUnderTheRequestedName(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `echo ready; sleep 30`)

	st := h.started(t)

	assert.Check(t, st.Created, "STARTED did not report a new session")
	assert.Check(t, cmp.Equal(st.Session, "main"))
	assert.Check(t, cmp.Equal(m.Attached(), 1))
}

func TestServeLeavesTheProcessRunningWhenTheViewerDetaches(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `echo ready; while read l; do echo "said $l"; done`)
	st := h.started(t)
	h.until(t, "ready")

	h.detach(t)

	info, ok := find(m, "main")
	assert.Assert(t, ok, "the session is gone")
	assert.Check(t, cmp.Equal(info.State, proto.SessionRunning))
	assert.Check(t, !info.Attached, "the session still counts a viewer")
	assert.Check(t, syscall.Kill(st.Pid, 0), "the process is gone")
	assert.Check(t, cmp.Equal(m.Attached(), 0))
}

// A later viewer gets the same process, the replay of what the session wrote
// while the first viewer watched, and live input; the detach sent no SIGHUP.
func TestServeReattachesToTheRunningProcessWithItsReplay(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `trap 'echo got-hup' HUP; echo ready; while read l; do echo "said $l"; done`)
	first := h.started(t)
	h.until(t, "ready")
	h.detach(t)

	again := attach(t, m, "main")
	st := again.started(t)
	again.until(t, "ready")
	again.send(t, proto.TypeStdin, []byte("hello\n"))
	again.until(t, "said hello")

	assert.Check(t, !st.Created, "the attach made a new session")
	assert.Check(t, cmp.Equal(st.Pid, first.Pid))
	assert.Check(t, !strings.Contains(again.out.String(), "got-hup"), "the detach sent SIGHUP")
}

// A viewer that comes back at the same size still makes the program redraw.
func TestServeSendsAResizeOnReattachAtTheSameSize(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `trap 'echo winch-$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)

	same := attach(t, m, "main")
	same.started(t)

	same.until(t, "winch-24 80")
}

func TestServeResizesTheSessionToANewViewersSize(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `trap 'echo winch-$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)

	wide := connect(t, m, proto.Request{Op: proto.OpSessionAttach, Session: "main", Cols: 120, Rows: 40})
	wide.started(t)
	wide.until(t, "winch-40 120")

	info, ok := find(m, "main")
	assert.Assert(t, ok, "the session is gone")
	assert.Check(t, cmp.Equal(info.Cols, uint16(120)))
	assert.Check(t, cmp.Equal(info.Rows, uint16(40)))
}

func TestServeHandsTheSessionToANewViewerAndDetachesTheOldOne(t *testing.T) {
	m := newTestManager(t)
	first := start(t, m, "main", `echo ready; while read l; do echo "said $l"; done`)
	first.started(t)
	first.until(t, "ready")

	second := attach(t, m, "main")
	second.started(t)
	f := first.last(t)
	first.waitServed(t)
	second.send(t, proto.TypeStdin, []byte("hi\n"))
	second.until(t, "said hi")

	assert.Equal(t, f.Type, proto.TypeDetached, "first viewer got %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Detached](t, f).Reason, proto.DetachTakenOver))
}

// A viewer whose host stopped reading, but never closed, does not keep a
// new viewer out.
func TestServeHandsTheSessionOnFromAHalfOpenViewer(t *testing.T) {
	shortenLastWrite(t)
	m := newTestManager(t)
	guest, conn := net.Pipe()
	t.Cleanup(func() { conn.Close() })
	stuck := &host{conn: conn, served: make(chan error, 1)}
	go func() {
		stuck.served <- m.Serve(proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"sh", "-c", "echo ready; while read l; do echo \"said $l\"; done"}}, guest, proto.NewReader(guest), proto.NewWriter(guest))
	}()
	waitFor(t, "the session", func() bool { _, ok := find(m, "main"); return ok })

	second := attach(t, m, "main")
	second.started(t)
	second.until(t, "ready")
	second.send(t, proto.TypeStdin, []byte("hi\n"))
	second.until(t, "said hi")

	// the stuck connection's writes time out, and its Serve returns
	stuck.waitServed(t)
}

func shortenLastWrite(t *testing.T) {
	t.Helper()
	saved := lastWriteTimeout
	lastWriteTimeout = 100 * time.Millisecond
	t.Cleanup(func() { lastWriteTimeout = saved })
}

func TestServeRecordsTheExitOfADetachedSession(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `read go; echo bye; exit 3`)
	h.started(t)
	h.send(t, proto.TypeStdin, []byte("go\n"))

	h.detach(t)

	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })
	info, _ := find(m, "job")
	assert.Assert(t, info.Exit != nil, "no exit recorded")
	assert.Check(t, cmp.Equal(info.Exit.Code, 3))
}

func TestServeGivesALaterViewerTheReplayAndTheExitOfADetachedSession(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `read go; echo bye; exit 3`)
	h.started(t)
	h.send(t, proto.TypeStdin, []byte("go\n"))
	h.detach(t)
	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })

	later := attach(t, m, "job")
	later.started(t)
	f := later.last(t)

	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, 3))
	assert.Check(t, cmp.Contains(later.out.String(), "bye"), "the replay lost the last output")
}

// Once a viewer has the EXIT, the session goes and its name finds nothing.
func TestServeRemovesAnExitedSessionOnceAViewerHasTheExit(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `read go; echo bye; exit 3`)
	h.started(t)
	h.send(t, proto.TypeStdin, []byte("go\n"))
	h.detach(t)
	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })
	later := attach(t, m, "job")
	later.started(t)
	later.last(t)

	waitFor(t, "the session to go", func() bool { _, ok := find(m, "job"); return !ok })
	code := attach(t, m, "job").errorCode(t)

	assert.Check(t, cmp.Equal(code, proto.ErrNoSession))
}

func TestServeSendsTheExitToTheAttachedViewerAndRemovesTheSession(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `echo bye; exit 4`)
	h.started(t)

	f := h.last(t)

	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, 4))
	waitFor(t, "the session to go", func() bool { _, ok := find(m, "job"); return !ok })
}

func TestKillHangsUpTheSessionsProcess(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `echo ready; sleep 30`)
	h.started(t)
	h.until(t, "ready")

	err := m.Kill("main")

	assert.NilError(t, err)
	f := h.last(t)
	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Signal, int(syscall.SIGHUP)))
}

func TestKillRefusesASessionThatIsAlreadyKilled(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `echo ready; sleep 30`)
	h.started(t)
	h.until(t, "ready")
	assert.NilError(t, m.Kill("main"))

	err := m.Kill("main")

	var pe *proto.Error
	assert.Assert(t, errors.As(err, &pe), "second kill: %v, want a protocol error", err)
	assert.Check(t, cmp.Equal(pe.Code, proto.ErrNoSession))
}

// A process that ignores SIGHUP gets SIGKILL after the kill grace.
func TestKillEscalatesToSIGKILLForAProcessThatIgnoresSIGHUP(t *testing.T) {
	// It waits out the real kill grace; it owns its manager and changes no
	// package setting, so it waits beside the other such test.
	t.Parallel()
	m := newTestManager(t)
	h := start(t, m, "main", `trap "" HUP; echo ready; while :; do sleep 0.05; done`)
	h.started(t)
	h.until(t, "ready")

	assert.NilError(t, m.Kill("main"))

	f := h.last(t)
	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Signal, int(syscall.SIGKILL)))
}

func TestServeRefusesABadRequestAndKeepsNoSession(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  proto.Request
		code string
	}{
		{name: "no tty", req: proto.Request{Op: proto.OpExec, Session: "main", Argv: []string{"true"}}, code: proto.ErrBadRequest},
		{name: "bad name", req: proto.Request{Op: proto.OpExec, Session: "Main", TTY: true, Argv: []string{"true"}}, code: proto.ErrBadRequest},
		{name: "long name", req: proto.Request{Op: proto.OpExec, Session: strings.Repeat("a", 33), TTY: true, Argv: []string{"true"}}, code: proto.ErrBadRequest},
		{name: "no such program", req: proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"no-such-program"}}, code: proto.ErrExecFailed},
		{name: "attach to nothing", req: proto.Request{Op: proto.OpSessionAttach, Session: "none"}, code: proto.ErrNoSession},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newTestManager(t)

			code := connect(t, m, tc.req).errorCode(t)

			assert.Check(t, cmp.Equal(code, tc.code))
			assert.Check(t, cmp.Len(m.List(), 0))
		})
	}
}

// fillSessions starts sessions s1 up to the cap's last slot and detaches
// from each, so they run on with no viewer.
func fillSessions(t *testing.T, m *Manager, from int) {
	t.Helper()
	for i := from; i < MaxSessions; i++ {
		h := start(t, m, fmt.Sprintf("s%d", i), "sleep 30")
		h.started(t)
		h.detach(t)
	}
}

// exitAfterDetach starts session name, whose process exits only once the
// test creates the returned file, and detaches from it first, so no viewer
// gets the EXIT. It returns once the session has exited.
func exitAfterDetach(t *testing.T, m *Manager, name string) {
	t.Helper()
	release := filepath.Join(t.TempDir(), "release")
	h := start(t, m, name, "while [ ! -e "+release+" ]; do sleep 0.01; done; exit 0")
	h.started(t)
	h.detach(t)
	assert.NilError(t, os.WriteFile(release, nil, 0o600))
	waitFor(t, name+" to exit", func() bool { info, _ := find(m, name); return info.State == proto.SessionExited })
}

// Exited sessions whose EXIT nobody got count toward the cap.
func TestServeRefusesANewSessionPastTheCap(t *testing.T) {
	m := newTestManager(t)
	exitAfterDetach(t, m, "s0")
	fillSessions(t, m, 1)

	code := start(t, m, "extra", "sleep 30").errorCode(t)

	assert.Check(t, cmp.Equal(code, proto.ErrSessionCap))
}

// The name of an exited session is free: a new session replaces it, even at
// the cap.
func TestServeReplacesAnExitedSessionOfTheSameName(t *testing.T) {
	m := newTestManager(t)
	exitAfterDetach(t, m, "s0")
	fillSessions(t, m, 1)

	h := start(t, m, "s0", "echo fresh; sleep 30")
	st := h.started(t)
	h.until(t, "fresh")

	assert.Check(t, st.Created, "the exited session was attached, not replaced")
}

func TestServeAttachesAnExecToARunningSessionOfTheSameName(t *testing.T) {
	m := newTestManager(t)
	first := start(t, m, "s1", "echo ready; sleep 30")
	first.started(t)
	first.until(t, "ready")
	first.detach(t)

	again := start(t, m, "s1", "echo other")
	st := again.started(t)

	assert.Check(t, !st.Created, "a running session was replaced")
}

// A viewer that stops reading is dropped; the program and the session go on.
func TestServeDropsAViewerThatStopsReading(t *testing.T) {
	m := newTestManager(t)
	guest, conn := net.Pipe()
	t.Cleanup(func() { conn.Close() })
	slow := &host{conn: conn, w: proto.NewWriter(conn), served: make(chan error, 1)}
	go func() {
		slow.served <- m.Serve(proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"sh", "-c", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"}}, guest, proto.NewReader(guest), proto.NewWriter(guest))
	}()

	waitFor(t, "the viewer to be dropped", func() bool { info, ok := find(m, "main"); return ok && !info.Attached })

	// the pump still runs: a new viewer gets live output
	fresh := attach(t, m, "main")
	fresh.started(t)
	var types, want []proto.Type
	for range 50 {
		types = append(types, fresh.next(t).Type)
		want = append(want, proto.TypeStdout)
	}
	assert.Check(t, cmp.DeepEqual(types, want))
	// the slow viewer, once it reads again, finds DETACHED slow at the end
	r := proto.NewReader(conn)
	var detached proto.Frame
	for detached.Type != proto.TypeDetached {
		f, err := r.Next()
		assert.NilError(t, err, "the connection ended without DETACHED")
		detached = f
	}
	assert.Check(t, cmp.Equal(decode[proto.Detached](t, detached).Reason, proto.DetachSlow))
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

func TestServeEndsOnlyTheViewerWhoseWriteFails(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "main", `echo ready; while read l; do echo "said $l"; done`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)
	guest, conn := net.Pipe()
	broken := serve(t, m, proto.Request{Op: proto.OpSessionAttach, Session: "main"}, &failingConn{Conn: guest}, conn)
	broken.started(t)

	broken.send(t, proto.TypeStdin, []byte("a\nb\nc\nd\n"))
	broken.waitServed(t)

	fresh := attach(t, m, "main")
	fresh.started(t)
	fresh.send(t, proto.TypeStdin, []byte("e\n"))
	fresh.until(t, "said e")
}

// An EXIT that a viewer could not be sent stays for the next viewer. With
// no echo, the EXIT is the first frame after STARTED and the replay, so the
// one write that fails is the EXIT's.
func TestServeKeepsAnExitTheViewerCouldNotBeSentForTheNextViewer(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `stty -echo; echo ready; read go; exit 5`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)
	guest, conn := net.Pipe()
	broken := serve(t, m, proto.Request{Op: proto.OpSessionAttach, Session: "job"}, &failingConn{Conn: guest}, conn)
	broken.started(t)
	broken.send(t, proto.TypeStdin, []byte("go\n"))
	broken.waitServed(t)
	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })

	later := attach(t, m, "job")
	later.started(t)
	f := later.last(t)

	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, 5))
	waitFor(t, "the session to go", func() bool { _, ok := find(m, "job"); return !ok })
}
