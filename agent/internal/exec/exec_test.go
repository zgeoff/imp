package exec

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"strings"
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

func newManager() *Manager {
	return NewManager(launch.New(testReaper, imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil)
}

// host is the host side of one exec connection.
type host struct {
	conn   net.Conn
	w      *proto.Writer
	frames chan proto.Frame
	served chan error
}

func startExec(t *testing.T, m *Manager, req proto.Request) *host {
	t.Helper()
	guest, conn := net.Pipe()
	h := &host{conn: conn, w: proto.NewWriter(conn), frames: make(chan proto.Frame, 64), served: make(chan error, 1)}
	go func() {
		h.served <- m.Serve(req, proto.NewReader(guest), proto.NewWriter(guest))
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

func (h *host) started(t *testing.T) int {
	t.Helper()
	f := h.next(t, 5*time.Second)
	if f.Type != proto.TypeStarted {
		t.Fatalf("first frame %s %q, want STARTED", f.Type, f.Payload)
	}
	var st proto.Started
	if err := json.Unmarshal(f.Payload, &st); err != nil {
		t.Fatal(err)
	}
	return st.Pid
}

func (h *host) next(t *testing.T, timeout time.Duration) proto.Frame {
	t.Helper()
	select {
	case f, ok := <-h.frames:
		if !ok {
			t.Fatal("connection closed")
		}
		return f
	case <-time.After(timeout):
		t.Fatalf("no frame within %s", timeout)
		return proto.Frame{}
	}
}

// wait collects stdout until EXIT.
func (h *host) wait(t *testing.T, timeout time.Duration) (string, proto.Exit) {
	t.Helper()
	var out bytes.Buffer
	deadline := time.Now().Add(timeout)
	for {
		f := h.next(t, time.Until(deadline))
		switch f.Type {
		case proto.TypeStdout, proto.TypeStderr:
			out.Write(f.Payload)
		case proto.TypeExit:
			var e proto.Exit
			if err := json.Unmarshal(f.Payload, &e); err != nil {
				t.Fatal(err)
			}
			return out.String(), e
		default:
			t.Fatalf("unexpected %s frame", f.Type)
		}
	}
}

func (h *host) send(t *testing.T, typ proto.Type, payload []byte) {
	t.Helper()
	if err := h.w.Write(typ, payload); err != nil {
		t.Fatal(err)
	}
}

func TestExec(t *testing.T) {
	big := bytes.Repeat([]byte("x"), 300<<10)
	tests := []struct {
		name  string
		argv  []string
		stdin []byte
		out   string
		exit  proto.Exit
	}{
		{"exit code", []string{"sh", "-c", "exit 3"}, nil, "", proto.Exit{Code: 3}},
		{"signal", []string{"sh", "-c", "kill -TERM $$"}, nil, "", proto.Exit{Code: 128 + 15, Signal: 15}},
		{"stdin then eof", []string{"cat"}, []byte("hello"), "hello", proto.Exit{}},
		// More than a pipe buffer, so the writer blocks on the child.
		{"large stdin", []string{"wc", "-c"}, big, "307200", proto.Exit{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := startExec(t, newManager(), proto.Request{Argv: tt.argv})
			h.started(t)
			go func() {
				if len(tt.stdin) > 0 {
					h.w.Write(proto.TypeStdin, tt.stdin)
				}
				h.w.Write(proto.TypeStdinEOF, nil)
			}()
			out, exit := h.wait(t, 5*time.Second)
			if strings.TrimSpace(out) != tt.out {
				t.Errorf("output %q, want %q", out, tt.out)
			}
			if exit != tt.exit {
				t.Errorf("exit %+v, want %+v", exit, tt.exit)
			}
			if err := <-h.served; err != nil {
				t.Errorf("Serve: %v", err)
			}
		})
	}
}

// TestSignalBehindUnreadStdin checks that a SIGNAL frame still arrives when
// the process never reads the stdin queued ahead of it.
func TestSignalBehindUnreadStdin(t *testing.T) {
	tests := []struct {
		name          string
		frames, bytes int
	}{
		// More than the pipe buffer holds.
		{"one large frame", 1, 512 << 10},
		// Keystrokes typed into a program that hangs, once the pipe is
		// full: each takes a queue slot.
		{"many small frames", 500, 8},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := startExec(t, newManager(), proto.Request{Argv: []string{"sleep", "30"}})
			h.started(t)
			h.send(t, proto.TypeStdin, bytes.Repeat([]byte("x"), 128<<10))
			for range tt.frames {
				h.send(t, proto.TypeStdin, bytes.Repeat([]byte("x"), tt.bytes))
			}
			sig, _ := json.Marshal(proto.Signal{Signal: int(syscall.SIGTERM)})
			h.send(t, proto.TypeSignal, sig)
			_, exit := h.wait(t, 3*time.Second)
			if exit.Signal != int(syscall.SIGTERM) {
				t.Fatalf("exit %+v, want SIGTERM", exit)
			}
		})
	}
}

// TestDrainDeadline checks that a background child holding stdout open does
// not hold the session open past drainGrace.
func TestDrainDeadline(t *testing.T) {
	h := startExec(t, newManager(), proto.Request{Argv: []string{"sh", "-c", "sleep 3 & echo hi"}})
	h.started(t)
	start := time.Now()
	out, exit := h.wait(t, 2*time.Second)
	if out != "hi\n" || exit.Code != 0 {
		t.Fatalf("got %q %+v", out, exit)
	}
	if d := time.Since(start); d > drainGrace+time.Second {
		t.Fatalf("EXIT after %s", d)
	}
}

func TestHangup(t *testing.T) {
	tests := []struct {
		name   string
		script string
		// detach means the process ignores SIGHUP and the session ends
		// after hangupGrace without it.
		detach bool
	}{
		{"process exits on SIGHUP", "echo ready; sleep 30", false},
		{"process ignores SIGHUP", `trap "" HUP; echo ready; sleep 30`, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newManager()
			h := startExec(t, m, proto.Request{Argv: []string{"sh", "-c", tt.script}})
			pid := h.started(t)
			defer syscall.Kill(-pid, syscall.SIGKILL)
			// Wait until the trap is set.
			if f := h.next(t, 5*time.Second); f.Type != proto.TypeStdout {
				t.Fatalf("got %s, want STDOUT", f.Type)
			}
			if m.Active() != 1 {
				t.Fatalf("Active() = %d, want 1", m.Active())
			}
			start := time.Now()
			h.conn.Close()
			var err error
			select {
			case err = <-h.served:
			case <-time.After(hangupGrace + 2*time.Second):
				t.Fatal("Serve did not return")
			}
			d := time.Since(start)
			if tt.detach {
				if err == nil || !strings.Contains(err.Error(), "ignored SIGHUP") {
					t.Errorf("Serve: %v, want a detach error", err)
				}
				if d < hangupGrace {
					t.Errorf("returned after %s, before hangupGrace", d)
				}
				if syscall.Kill(pid, 0) != nil {
					t.Error("process is gone, want it left running")
				}
			} else if d >= hangupGrace {
				t.Errorf("returned after %s, want before hangupGrace", d)
			}
			if m.Active() != 0 {
				t.Errorf("Active() = %d, want 0", m.Active())
			}
		})
	}
}
