package exec

import (
	"bytes"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/testing/protocmp"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

// The reaper runs a process-wide wait4 loop, so the package shares one.
var testReaper *reaper.Reaper

// zombieParentEnv makes the test binary a parent that forks /bin/true,
// writes its pid to the named file and never waits for it, so the child
// stays a zombie until this parent dies.
const zombieParentEnv = "EXEC_TEST_ZOMBIE_PARENT"

func TestMain(m *testing.M) {
	if pidFile := os.Getenv(zombieParentEnv); pidFile != "" {
		pid, err := syscall.ForkExec("/bin/true", []string{"true"}, &syscall.ProcAttr{})
		if err != nil {
			os.Exit(1)
		}
		if err := os.WriteFile(pidFile, []byte(strconv.Itoa(pid)), 0o600); err != nil {
			os.Exit(1)
		}
		// Block in a syscall, which the runtime does not count as a
		// deadlock (a bare select{} is one without cgo).
		for {
			unix.Pause()
		}
	}
	testReaper = reaper.New()
	os.Exit(m.Run())
}

func newManager() *Manager {
	return NewManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil), nil)
}

// host is the host side of one exec connection.
type host struct {
	conn   net.Conn
	w      *proto.Writer
	frames chan proto.Frame
	served chan error
}

func startExec(t *testing.T, m *Manager, req *proto.Request) *host {
	t.Helper()
	guest, conn := net.Pipe()
	h := &host{conn: conn, w: proto.NewWriter(conn), frames: make(chan proto.Frame, 64), served: make(chan error, 1)}
	stop, serveDone, readDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	// The hangup ends Serve: within the hangup grace for a process that
	// ignores it, and at once otherwise. Cleanups registered later, such as
	// a kill of the process, run first.
	t.Cleanup(func() {
		close(stop)
		conn.Close()
		for _, done := range []chan struct{}{serveDone, readDone} {
			select {
			case <-done:
			case <-time.After(m.hangupGrace + 5*time.Second):
				t.Error("a goroutine of the exec connection did not end")
			}
		}
	})
	go func() {
		defer close(serveDone)
		h.served <- m.Serve(req, proto.NewReader(guest), proto.NewWriter(guest))
		guest.Close()
	}()
	go func() {
		defer close(readDone)
		defer close(h.frames)
		r := proto.NewReader(conn)
		for {
			f, err := r.Next()
			if err != nil {
				return
			}
			select {
			case h.frames <- f:
			case <-stop:
				return
			}
		}
	}()
	return h
}

func (h *host) started(t *testing.T) int {
	t.Helper()
	f := h.next(t, 5*time.Second)
	assert.Equal(t, f.Type, proto.TypeStarted, "first frame %q", f.Payload)
	var st proto.Started
	assert.NilError(t, proto.Unmarshal(f.Payload, &st))
	return int(st.Pid)
}

func (h *host) next(t *testing.T, timeout time.Duration) proto.Frame {
	t.Helper()
	select {
	case f, ok := <-h.frames:
		assert.Assert(t, ok, "connection closed")
		return f
	case <-time.After(timeout):
		t.Fatalf("no frame within %s", timeout)
		return proto.Frame{}
	}
}

// wait collects stdout and stderr until EXIT.
func (h *host) wait(t *testing.T, timeout time.Duration) (string, *proto.Exit) {
	t.Helper()
	var out bytes.Buffer
	deadline := time.Now().Add(timeout)
	for {
		f := h.next(t, time.Until(deadline))
		switch f.Type {
		case proto.TypeStdout, proto.TypeStderr:
			out.Write(f.Payload)
		case proto.TypeExit:
			e := &proto.Exit{}
			assert.NilError(t, proto.Unmarshal(f.Payload, e))
			return out.String(), e
		default:
			t.Fatalf("unexpected %s frame", f.Type)
		}
	}
}

// hangUp closes the host side, as a host does once it has EXIT, and returns
// what Serve returned.
func (h *host) hangUp(t *testing.T, timeout time.Duration) error {
	t.Helper()
	h.conn.Close()
	select {
	case err := <-h.served:
		return err
	case <-time.After(timeout):
		t.Fatalf("Serve did not return within %s of the hangup", timeout)
		return nil
	}
}

func (h *host) send(t *testing.T, typ proto.Type, payload []byte) {
	t.Helper()
	assert.NilError(t, h.w.Write(typ, payload))
}

func TestServeForwardsStdinAndReportsTheExit(t *testing.T) {
	for _, tc := range []struct {
		name  string
		argv  []string
		stdin []byte
		out   string
		exit  *proto.Exit
	}{
		{name: "exit code", argv: []string{"sh", "-c", "exit 3"}, out: "", exit: &proto.Exit{Code: 3}},
		{name: "signal", argv: []string{"sh", "-c", "kill -TERM $$"}, out: "", exit: &proto.Exit{Code: 128 + 15, Signal: 15}},
		{name: "stdin then eof", argv: []string{"cat"}, stdin: []byte("hello"), out: "hello", exit: &proto.Exit{}},
		// More than a pipe buffer, so the writer blocks on the child.
		{name: "large stdin", argv: []string{"wc", "-c"}, stdin: bytes.Repeat([]byte("x"), 300<<10), out: "307200", exit: &proto.Exit{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := startExec(t, newManager(), &proto.Request{Argv: tc.argv})
			h.started(t)
			written := make(chan error, 1)
			go func() {
				if len(tc.stdin) > 0 {
					if err := h.w.Write(proto.TypeStdin, tc.stdin); err != nil {
						written <- err
						return
					}
				}
				written <- h.w.Write(proto.TypeStdinEOF, nil)
			}()

			out, exit := h.wait(t, 5*time.Second)
			writeErr := <-written
			served := h.hangUp(t, time.Second)

			assert.Check(t, cmp.Equal(strings.TrimSpace(out), tc.out))
			assert.Check(t, cmp.DeepEqual(exit, tc.exit, protocmp.Transform()))
			assert.Check(t, writeErr, "host stdin write")
			assert.Check(t, served, "Serve")
		})
	}
}

func TestServeDeliversASignalQueuedBehindStdinTheProcessNeverReads(t *testing.T) {
	for _, tc := range []struct {
		name          string
		frames, bytes int
	}{
		// More than the pipe buffer holds.
		{name: "one large frame", frames: 1, bytes: 512 << 10},
		// Keystrokes typed into a program that hangs, once the pipe is
		// full: each takes a queue slot.
		{name: "many small frames", frames: 500, bytes: 8},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := startExec(t, newManager(), &proto.Request{Argv: []string{"sleep", "30"}})
			h.started(t)
			h.send(t, proto.TypeStdin, bytes.Repeat([]byte("x"), 128<<10))
			for range tc.frames {
				h.send(t, proto.TypeStdin, bytes.Repeat([]byte("x"), tc.bytes))
			}
			sig, err := proto.Marshal(&proto.Signal{Signal: int32(syscall.SIGTERM)})
			assert.NilError(t, err)

			h.send(t, proto.TypeSignal, sig)
			_, exit := h.wait(t, 3*time.Second)

			assert.Equal(t, exit.Signal, int32(syscall.SIGTERM))
		})
	}
}

// A background child that keeps stdout open must not hold the session open
// past the drain grace.
func TestServeSendsTheExitWithinTheDrainGraceWhileABackgroundChildHoldsStdout(t *testing.T) {
	m := newManager()
	m.drainGrace = 100 * time.Millisecond
	h := startExec(t, m, &proto.Request{Argv: []string{"sh", "-c", "sleep 3 & echo hi"}})
	h.started(t)

	start := time.Now()
	out, exit := h.wait(t, 2*time.Second)
	took := time.Since(start)

	assert.Check(t, cmp.Equal(out, "hi\n"))
	assert.Check(t, cmp.DeepEqual(exit, &proto.Exit{}, protocmp.Transform()))
	assert.Check(t, took <= m.drainGrace+time.Second, "EXIT after %s", took)
}

func TestServeReturnsBeforeTheHangupGraceWhenTheProcessExitsOnSIGHUP(t *testing.T) {
	m := newManager()
	// long enough that only the process's own exit ends Serve in time
	m.hangupGrace = 5 * time.Second
	h := startExec(t, m, &proto.Request{Argv: []string{"sh", "-c", "echo ready; sleep 30"}})
	pid := h.started(t)
	t.Cleanup(func() { syscall.Kill(-pid, syscall.SIGKILL) })
	f := h.next(t, 5*time.Second)
	assert.Equal(t, f.Type, proto.TypeStdout, "the ready line")
	activeBefore := m.Active()

	start := time.Now()
	// Serve's EXIT then meets the closed connection, so its error is no
	// part of this contract.
	h.hangUp(t, m.hangupGrace+2*time.Second)
	took := time.Since(start)

	assert.Check(t, cmp.Equal(activeBefore, 1), "sessions before the hangup")
	assert.Check(t, took < m.hangupGrace, "returned after %s, want before the hangup grace", took)
	assert.Check(t, cmp.Equal(m.Active(), 0))
}

// A process that ignores SIGHUP keeps running after the host hangs up, but
// no longer counts as a session.
func TestServeDetachesAProcessThatIgnoresSIGHUPAfterTheHangupGrace(t *testing.T) {
	m := newManager()
	m.hangupGrace = 200 * time.Millisecond
	// The process prints once its trap is set.
	h := startExec(t, m, &proto.Request{Argv: []string{"sh", "-c", `trap "" HUP; echo ready; sleep 30`}})
	pid := h.started(t)
	t.Cleanup(func() { syscall.Kill(-pid, syscall.SIGKILL) })
	f := h.next(t, 5*time.Second)
	assert.Equal(t, f.Type, proto.TypeStdout, "the ready line")
	activeBefore := m.Active()

	start := time.Now()
	err := h.hangUp(t, m.hangupGrace+2*time.Second)
	took := time.Since(start)

	assert.Check(t, cmp.Equal(activeBefore, 1), "sessions before the hangup")
	assert.Check(t, cmp.ErrorContains(err, "ignored SIGHUP"))
	assert.Check(t, took >= m.hangupGrace, "returned after %s, before the hangup grace", took)
	assert.Check(t, syscall.Kill(pid, 0), "the process is gone, want it left running")
	assert.Check(t, cmp.Equal(m.Active(), 0))
}

// Output is forwarded for half a second after the process exits, and a
// process that ignores a hangup has a second to end.
func TestNewManagersTakeTheDrainAndHangupGraces(t *testing.T) {
	l := launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{}), nil)
	for _, tc := range []struct {
		name string
		m    *Manager
	}{
		{name: "plain", m: NewManager(l, nil)},
		{name: "strict", m: NewStrictManager(l, nil)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Check(t, cmp.Equal(tc.m.drainGrace, 500*time.Millisecond))
			assert.Check(t, cmp.Equal(tc.m.hangupGrace, time.Second))
		})
	}
}

// Host frames sent after the process exited, past what the stdin queue
// holds, are still read, so none meets a closed socket: a host whose write
// fails there loses the EXIT frame to EPIPE.
func TestServeReadsHostFramesThatArriveAfterTheExit(t *testing.T) {
	h := startExec(t, newManager(), &proto.Request{Argv: []string{"sh", "-c", "echo refused >&2; exit 1"}})
	h.started(t)
	h.wait(t, 5*time.Second)

	// More than stdinQueueChunks of stdinChunk, all after the session ended.
	written := make(chan error, 1)
	go func() {
		chunk := bytes.Repeat([]byte("x"), 64<<10)
		for range (stdinQueueChunks*stdinChunk)/len(chunk) + 16 {
			if err := h.w.Write(proto.TypeStdin, chunk); err != nil {
				written <- err
				return
			}
		}
		written <- h.w.Write(proto.TypeStdinEOF, nil)
	}()
	var writeErr error
	select {
	case writeErr = <-written:
	case <-time.After(exitLinger):
		t.Fatal("host writes after EXIT were not read within exitLinger")
	}
	served := h.hangUp(t, time.Second)

	assert.Check(t, writeErr, "host write after EXIT")
	assert.Check(t, served, "Serve")
}
