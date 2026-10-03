package session

import (
	"bytes"
	"net"
	"strconv"
	"testing"

	"github.com/zgeoff/imp/agent/internal/proto"
)

func startLogged(t *testing.T, m *Manager, name, script string) *host {
	t.Helper()
	return connect(t, m, proto.Request{Op: proto.OpExec, Session: name, TTY: true, Log: true,
		Argv: []string{"sh", "-c", script}, Cols: 80, Rows: 24})
}

func tap(t *testing.T, m *Manager, name string, resume *proto.ResumeFrom) *host {
	t.Helper()
	return connect(t, m, proto.Request{Op: proto.OpSessionTap, Session: name, ResumeFrom: resume})
}

// taps reads how many taps the session has now.
func taps(m *Manager, name string) int {
	m.mu.Lock()
	s := m.sessions[name]
	m.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.taps)
}

// A tap reads the raw output from the ring's start, then live output and the
// EXIT, beside a viewer it never takes over, and counts as no connection.
func TestTapRunsBesideTheViewer(t *testing.T) {
	m := newTestManager(t)
	viewer := startLogged(t, m, "job", "stty -opost -echo; printf one; read go; printf two; exit 5")
	_, vout := viewer.output(t)
	if !vout.Log {
		t.Fatalf("output %+v, want log", vout)
	}
	viewer.until(t, "one")

	tp := tap(t, m, "job", nil)
	st, out := tp.output(t)
	if st.Session != "job" || out.Offset != 0 || out.Prelude != 0 || out.Resume != nil || out.Generation != vout.Generation || !out.Log {
		t.Fatalf("tap STARTED %+v output %+v", st, out)
	}
	tp.until(t, "one")
	waitFor(t, "the tap", func() bool { return taps(m, "job") == 1 })
	if got := m.Attached(); got != 1 {
		t.Fatalf("Attached() = %d with a viewer and a tap, want 1", got)
	}
	if info, _ := find(m, "job"); !info.Attached || !info.Log {
		t.Fatalf("info %+v, want attached and log", info)
	}

	viewer.send(t, proto.TypeStdin, []byte("go\n"))
	for _, h := range []*host{viewer, tp} {
		f := h.last(t)
		if f.Type != proto.TypeExit || decode[proto.Exit](t, f).Code != 5 {
			t.Fatalf("got %s %q, want EXIT 5", f.Type, f.Payload)
		}
	}
	if got := tp.out.String(); got != "onetwo" {
		t.Fatalf("tap read %q, want the raw output onetwo", got)
	}
}

// A tap gets the EXIT without delivering it: the next viewer still gets it.
func TestTapLeavesTheExitForAViewer(t *testing.T) {
	m := newTestManager(t)
	h := startLogged(t, m, "job", "read go; exit 3")
	h.started(t)
	h.detach(t)

	tp := tap(t, m, "job", nil)
	tp.started(t)
	waitFor(t, "the tap", func() bool { return taps(m, "job") == 1 })
	viewer := attach(t, m, "job")
	viewer.started(t)
	viewer.send(t, proto.TypeStdin, []byte("go\n"))
	viewer.detach(t)
	if f := tp.last(t); f.Type != proto.TypeExit {
		t.Fatalf("tap got %s, want EXIT", f.Type)
	}

	// a tap after the exit gets the tail and the EXIT, and still leaves it
	late := tap(t, m, "job", nil)
	late.started(t)
	if f := late.last(t); f.Type != proto.TypeExit {
		t.Fatalf("late tap got %s, want EXIT", f.Type)
	}
	later := attach(t, m, "job")
	later.started(t)
	if f := later.last(t); f.Type != proto.TypeExit || decode[proto.Exit](t, f).Code != 3 {
		t.Fatalf("viewer got %s %q, want EXIT 3", f.Type, f.Payload)
	}
}

// A tap resumes by offset with the ring's rules: exact, and a gap below the
// ring's start.
func TestTapResumes(t *testing.T) {
	m := newTestManager(t)
	total := uint64(ringSize + 1000)
	out := startLoggedQuiet(t, m, "job", "head -c "+strconv.FormatUint(total, 10)+" /dev/zero | tr '\\0' x", total)

	exact := tap(t, m, "job", &proto.ResumeFrom{Generation: out.Generation, Offset: total - 10})
	_, eo := exact.output(t)
	if eo.Resume == nil || eo.Resume.Kind != proto.ResumeExact || eo.Offset != total-10 {
		t.Fatalf("exact resume: %+v", eo)
	}
	if got := exact.data(t, 10); !bytes.Equal(got, bytes.Repeat([]byte("x"), 10)) {
		t.Fatalf("exact resume read %q", got)
	}

	gap := tap(t, m, "job", &proto.ResumeFrom{Generation: out.Generation, Offset: 5})
	_, gout := gap.output(t)
	if gout.Resume == nil || gout.Resume.Kind != proto.ResumeGap || *gout.Resume.From != 5 || *gout.Resume.To != 1000 || gout.Offset != 1000 {
		t.Fatalf("gap resume: %+v %s", gout, wire(t, gout.Resume))
	}

	past := tap(t, m, "job", &proto.ResumeFrom{Generation: out.Generation, Offset: total + 1})
	if code := past.errorCode(t); code != proto.ErrInvalidResume {
		t.Fatalf("resume past the end: %s, want INVALID_RESUME", code)
	}
}

func TestTapRefusals(t *testing.T) {
	m := newTestManager(t)
	if code := tap(t, m, "none", nil).errorCode(t); code != proto.ErrNoSession {
		t.Fatalf("tap of no session: %s, want NO_SESSION", code)
	}
	h := start(t, m, "plain", "exec sleep 60")
	h.started(t)
	if code := tap(t, m, "plain", nil).errorCode(t); code != proto.ErrBadRequest {
		t.Fatalf("tap of a session without a log: %s, want BAD_REQUEST", code)
	}
	if got := m.Attached(); got != 1 {
		t.Fatalf("Attached() = %d after refused taps, want 1", got)
	}
}

// A tap that stops reading is dropped as a slow viewer is; the viewer keeps
// its live output.
func TestSlowTapIsDropped(t *testing.T) {
	m := newTestManager(t)
	viewer := startLogged(t, m, "main", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done")
	viewer.started(t)
	go func() {
		for range viewer.frames {
		}
	}()

	guest, conn := net.Pipe()
	t.Cleanup(func() { conn.Close() })
	go m.Serve(proto.Request{Op: proto.OpSessionTap, Session: "main"}, guest, proto.NewReader(guest), proto.NewWriter(guest))
	r := proto.NewReader(conn)
	f, err := r.Next()
	if err != nil || f.Type != proto.TypeStarted {
		t.Fatalf("tap: %v %v, want STARTED", f.Type, err)
	}
	from := decode[proto.Started](t, f).Output.End

	// past maxQueued of output after the tap's STARTED, the tap that read
	// none of it is gone; the viewer is not
	waitFor(t, "more output", func() bool { info, _ := find(m, "main"); return info.End > from+maxQueued+(1<<20) })
	if n := taps(m, "main"); n != 0 {
		t.Fatalf("%d taps after the tap fell behind, want 0", n)
	}
	if info, _ := find(m, "main"); !info.Attached {
		t.Fatal("the viewer went with the tap")
	}
	for {
		f, err := r.Next()
		if err != nil {
			t.Fatalf("tap ended without DETACHED: %v", err)
		}
		if f.Type == proto.TypeDetached {
			if reason := decode[proto.Detached](t, f).Reason; reason != proto.DetachSlow {
				t.Fatalf("reason %q, want slow", reason)
			}
			return
		}
	}
}

// startLoggedQuiet is startQuiet for a logged session.
func startLoggedQuiet(t *testing.T, m *Manager, name, script string, n uint64) proto.Output {
	t.Helper()
	h := startLogged(t, m, name, "stty -opost -echo; "+script+"; exec sleep 60")
	_, out := h.output(t)
	h.detach(t)
	waitFor(t, "the output", func() bool {
		info, _ := find(m, name)
		return info.End == n
	})
	return out
}
