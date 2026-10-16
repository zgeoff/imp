package session

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/proto"
)

func startLogged(t *testing.T, m *Manager, name, script string) *host {
	t.Helper()
	return connect(t, m, &proto.Request{Op: proto.OpExec, Session: new(name), Tty: new(true), Log: new(true),
		Argv: []string{"sh", "-c", script}, Cols: new(uint32(80)), Rows: new(uint32(24))})
}

func tap(t *testing.T, m *Manager, name string, resume *proto.ResumeFrom) *host {
	t.Helper()
	return connect(t, m, &proto.Request{Op: proto.OpSessionTap, Session: new(name), ResumeFrom: resume})
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

// heldForTap reads whether the session's pump holds its output for a tap.
func heldForTap(m *Manager, name string) bool {
	m.mu.Lock()
	s := m.sessions[name]
	m.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.phase == phaseHeldForTap
}

// waitOnFile is a script line that blocks until path exists, so the test
// decides when the program moves on.
func waitOnFile(path string) string {
	return "while [ ! -e " + path + " ]; do sleep 0.01; done"
}

func touch(t *testing.T, path string) {
	t.Helper()
	assert.NilError(t, os.WriteFile(path, nil, 0o600))
}

func TestLoggedStartMarksItsOutputAsLogged(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")

	viewer := startLogged(t, m, "job", "exec sleep 60")

	_, out := viewer.output(t)
	assert.Check(t, out.GetLog())
}

// A tap reads the raw output from the ring's start beside a viewer it never
// takes over, and counts as no connection.
func TestTapReadsFromTheRingStartBesideTheViewer(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	viewer := startLogged(t, m, "job", "stty -opost -echo; printf one; exec sleep 60")
	_, vout := viewer.output(t)
	viewer.until(t, "one")

	tp := tap(t, m, "job", nil)

	st, out := tp.output(t)
	assert.Check(t, cmp.Equal(st.GetSession(), "job"))
	assert.Check(t, cmp.Equal(out.Offset, 0.0))
	assert.Check(t, cmp.Equal(out.Prelude, uint32(0)))
	assert.Check(t, cmp.Nil(out.Resume))
	assert.Check(t, cmp.Equal(out.ExecutionGeneration, vout.ExecutionGeneration))
	assert.Check(t, out.GetLog())
	tp.until(t, "one")
	waitFor(t, "the tap", func() bool { return taps(m, "job") == 1 })
	assert.Check(t, cmp.Equal(m.Attached(), 1), "a viewer and a tap")
	info, _ := find(m, "job")
	assert.Check(t, info.Attached)
	assert.Check(t, info.GetLog())
}

// A tap reads live output and the EXIT as the viewer does.
func TestTapReadsTheLiveOutputAndTheExitBesideTheViewer(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	viewer := startLogged(t, m, "job", "stty -opost -echo; printf one; read go; printf two; exit 5")
	viewer.output(t)
	viewer.until(t, "one")
	tp := tap(t, m, "job", nil)
	tp.output(t)
	tp.until(t, "one")
	waitFor(t, "the tap", func() bool { return taps(m, "job") == 1 })

	viewer.send(t, proto.TypeStdin, []byte("go\n"))

	vf := viewer.last(t)
	assert.Check(t, cmp.Equal(vf.Type, proto.TypeExit))
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, vf).Code, int32(5)))
	tf := tp.last(t)
	assert.Check(t, cmp.Equal(tf.Type, proto.TypeExit))
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, tf).Code, int32(5)))
	assert.Check(t, cmp.Equal(tp.out.String(), "onetwo"), "the tap reads the raw output")
}

// A tap of a session with no viewer gets its EXIT.
func TestTapGetsTheExitOfASessionWithNoViewer(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	ready := filepath.Join(t.TempDir(), "go")
	h := startLogged(t, m, "job", waitOnFile(ready)+"; exit 3")
	h.started(t)
	h.detach(t)
	tp := tap(t, m, "job", nil)
	tp.started(t)
	waitFor(t, "the tap", func() bool { return taps(m, "job") == 1 })

	touch(t, ready)

	f := tp.last(t)
	assert.Check(t, cmp.Equal(f.Type, proto.TypeExit))
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, int32(3)))
}

// A tap gets the EXIT without delivering it: the next viewer still gets it.
func TestTapLeavesTheExitItGotForTheNextViewer(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	ready := filepath.Join(t.TempDir(), "go")
	h := startLogged(t, m, "job", waitOnFile(ready)+"; exit 3")
	h.started(t)
	h.detach(t)
	tp := tap(t, m, "job", nil)
	tp.started(t)
	waitFor(t, "the tap", func() bool { return taps(m, "job") == 1 })
	touch(t, ready)
	tp.last(t)

	viewer := attach(t, m, "job")

	viewer.started(t)
	f := viewer.last(t)
	assert.Check(t, cmp.Equal(f.Type, proto.TypeExit))
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, int32(3)))
}

// A tap that comes after the exit gets the EXIT.
func TestTapAfterTheExitGetsTheExit(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	ready := filepath.Join(t.TempDir(), "go")
	h := startLogged(t, m, "job", waitOnFile(ready)+"; exit 3")
	h.started(t)
	h.detach(t)
	touch(t, ready)
	waitFor(t, "the exit", func() bool {
		info, _ := find(m, "job")
		return info.State == proto.SessionExited
	})

	late := tap(t, m, "job", nil)

	late.started(t)
	f := late.last(t)
	assert.Check(t, cmp.Equal(f.Type, proto.TypeExit))
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, int32(3)))
}

// A tap that comes after the exit still leaves the EXIT for the next viewer.
func TestTapAfterTheExitLeavesTheExitForTheNextViewer(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	ready := filepath.Join(t.TempDir(), "go")
	h := startLogged(t, m, "job", waitOnFile(ready)+"; exit 3")
	h.started(t)
	h.detach(t)
	touch(t, ready)
	waitFor(t, "the exit", func() bool {
		info, _ := find(m, "job")
		return info.State == proto.SessionExited
	})
	late := tap(t, m, "job", nil)
	late.started(t)
	late.last(t)

	viewer := attach(t, m, "job")

	viewer.started(t)
	f := viewer.last(t)
	assert.Check(t, cmp.Equal(f.Type, proto.TypeExit))
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, int32(3)))
}

func TestTapResumesExactlyAtAnOffsetTheRingHolds(t *testing.T) {
	shortenTapWait(t, 100*time.Millisecond)
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	total := uint64(ringSize + 1000)
	out := startLoggedQuiet(t, m, "job", "head -c "+strconv.FormatUint(total, 10)+" /dev/zero | tr '\\0' x", total)

	exact := tap(t, m, "job", &proto.ResumeFrom{ExecutionGeneration: out.ExecutionGeneration, Offset: float64(total - 10)})

	_, eo := exact.output(t)
	assert.Assert(t, eo.Resume != nil, "exact resume: %v", eo)
	assert.Check(t, cmp.Equal(eo.Resume.Kind, proto.ResumeExact))
	assert.Check(t, cmp.Equal(eo.Offset, float64(total-10)))
	assert.Check(t, cmp.DeepEqual(exact.data(t, 10), bytes.Repeat([]byte("x"), 10)))
}

// A resume below the ring's start is a gap up to it.
func TestTapResumeBelowTheRingStartIsAGap(t *testing.T) {
	shortenTapWait(t, 100*time.Millisecond)
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	total := uint64(ringSize + 1000)
	out := startLoggedQuiet(t, m, "job", "head -c "+strconv.FormatUint(total, 10)+" /dev/zero | tr '\\0' x", total)

	gap := tap(t, m, "job", &proto.ResumeFrom{ExecutionGeneration: out.ExecutionGeneration, Offset: 5})

	_, gout := gap.output(t)
	assert.Check(t, cmp.Equal(wire(t, gout.Resume), `{"kind":"gap","from":5,"to":1000}`))
	assert.Check(t, cmp.Equal(gout.Offset, 1000.0))
}

func TestTapResumePastTheEndIsInvalid(t *testing.T) {
	shortenTapWait(t, 100*time.Millisecond)
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	total := uint64(ringSize + 1000)
	out := startLoggedQuiet(t, m, "job", "head -c "+strconv.FormatUint(total, 10)+" /dev/zero | tr '\\0' x", total)

	past := tap(t, m, "job", &proto.ResumeFrom{ExecutionGeneration: out.ExecutionGeneration, Offset: float64(total + 1)})

	assert.Equal(t, past.errorCode(t), proto.ErrInvalidResume)
}

func TestTapOfNoSessionIsNoSession(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")

	code := tap(t, m, "none", nil).errorCode(t)

	assert.Equal(t, code, proto.ErrNoSession)
}

func TestTapOfASessionWithoutALogIsABadRequest(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "plain", "exec sleep 60")
	h.started(t)

	code := tap(t, m, "plain", nil).errorCode(t)

	assert.Check(t, cmp.Equal(code, proto.ErrBadRequest))
	assert.Check(t, cmp.Equal(m.Attached(), 1), "the refused tap left the viewer as the only connection")
}

// A tap that stops reading is dropped as a slow viewer is; the viewer keeps
// its live output.
func TestTapThatStopsReadingIsDroppedAsSlow(t *testing.T) {
	shortenTapWait(t, 100*time.Millisecond)
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	viewer := startLogged(t, m, "main", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done")
	viewer.started(t)
	drained := make(chan struct{})
	// registered after the viewer's own, so it runs first: the viewer's
	// close ends its frames, and so this drain
	t.Cleanup(func() {
		viewer.conn.Close()
		joined(t, drained, "the viewer's drain")
	})
	go func() {
		defer close(drained)
		for range viewer.frames {
		}
	}()
	guest, conn := net.Pipe()
	assert.NilError(t, conn.SetReadDeadline(time.Now().Add(10*time.Second)))

	served := runServe(t, m, &proto.Request{Op: proto.OpSessionTap, Session: new("main")}, guest, conn)

	r := proto.NewReader(conn)
	f, err := r.Next()
	assert.NilError(t, err)
	assert.Equal(t, f.Type, proto.TypeStarted)
	from := decode[proto.Started](t, f).Output.End
	// past maxQueued of output after the tap's STARTED, the tap that read
	// none of it is gone; the viewer is not
	waitFor(t, "more output", func() bool { info, _ := find(m, "main"); return info.End > from+maxQueued+(1<<20) })
	assert.Check(t, cmp.Equal(taps(m, "main"), 0), "taps after the tap fell behind")
	info, _ := find(m, "main")
	assert.Check(t, info.Attached, "the viewer went with the tap")
	// the tap, once it reads again, finds DETACHED slow at the end
	var detached proto.Frame
	for detached.Type != proto.TypeDetached {
		f, err := r.Next()
		assert.NilError(t, err, "the tap ended without DETACHED")
		detached = f
	}
	assert.Check(t, cmp.Equal(decode[proto.Detached](t, detached).Reason, proto.DetachSlow))
	select {
	case err := <-served:
		assert.Check(t, err, "Serve")
	case <-time.After(5 * time.Second):
		t.Fatal("the dropped tap's Serve did not return")
	}
}

func shortenTapWait(t *testing.T, d time.Duration) {
	t.Helper()
	old := tapWait
	tapWait = d
	t.Cleanup(func() { tapWait = old })
}

// A logged session's output waits for its first tap rather than let the
// ring drop bytes no tap took.
func TestLoggedSessionHoldsItsOutputWithinTheRingUntilATap(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	total := 4 * ringSize

	h := startLogged(t, m, "job", "stty -opost -echo; head -c "+strconv.Itoa(total)+" /dev/zero | tr '\\0' x; exec sleep 60")
	h.started(t)
	h.detach(t)

	waitFor(t, "the hold for a tap", func() bool { return heldForTap(m, "job") })
	info, _ := find(m, "job")
	assert.Check(t, info.End <= ringSize, "end %d before a tap, want at most the ring, %d", info.End, ringSize)
}

// A tap that comes while the session holds its output still reads from 0.
func TestTapOfAHeldLoggedSessionReadsItsOutputFromZero(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	total := 4 * ringSize
	h := startLogged(t, m, "job", "stty -opost -echo; head -c "+strconv.Itoa(total)+" /dev/zero | tr '\\0' x; exec sleep 60")
	h.started(t)
	h.detach(t)
	waitFor(t, "the hold for a tap", func() bool { return heldForTap(m, "job") })

	tp := tap(t, m, "job", nil)

	_, out := tp.output(t)
	assert.Check(t, cmp.Equal(out.Offset, 0.0))
	// bytes.Equal: go-cmp walks a megabyte one element at a time
	got := tp.data(t, total)
	assert.Check(t, bytes.Equal(got, bytes.Repeat([]byte("x"), total)), "the tap read %d bytes, want %d x's", len(got), total)
}

// With no tap within tapWait, the session runs on untapped: all its output
// passes through the ring.
func TestLoggedSessionRunsOnWithoutATapPastTheTapWait(t *testing.T) {
	shortenTapWait(t, 100*time.Millisecond)
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	total := uint64(4 * ringSize)

	startLoggedQuiet(t, m, "job", "head -c "+strconv.FormatUint(total, 10)+" /dev/zero | tr '\\0' x", total)
}

// startLoggedQuiet is startQuiet for a logged session.
func startLoggedQuiet(t *testing.T, m *Manager, name, script string, n uint64) *proto.Output {
	t.Helper()
	h := startLogged(t, m, name, "stty -opost -echo; "+script+"; exec sleep 60")
	_, out := h.output(t)
	h.detach(t)
	waitFor(t, "the output", func() bool {
		info, ok := find(m, name)
		return ok && info.End == float64(n)
	})
	return out
}

// log turns logging on only for the session a start creates: a start that
// attaches to a session that runs leaves it unlogged.
func TestLoggedStartThatAttachesLeavesTheSessionUnlogged(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "job", "exec sleep 60")
	h.started(t)
	h.detach(t)

	again := startLogged(t, m, "job", "exec sleep 60")

	st, out := again.output(t)
	assert.Check(t, !st.GetCreated(), "the start attached")
	assert.Check(t, cmp.Nil(out.Log), "the attach carries no log")
}

func TestTapOfASessionALoggedStartAttachedToIsABadRequest(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "job", "exec sleep 60")
	h.started(t)
	h.detach(t)
	again := startLogged(t, m, "job", "exec sleep 60")
	again.output(t)

	code := tap(t, m, "job", nil).errorCode(t)

	assert.Equal(t, code, proto.ErrBadRequest)
}
