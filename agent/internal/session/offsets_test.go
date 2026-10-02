package session

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/zgeoff/imp/agent/internal/proto"
)

const testBootID = "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11"

var generationPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// output reads the STARTED's output, which a session connection always has.
func (h *host) output(t *testing.T) (proto.Started, proto.Output) {
	t.Helper()
	st := h.started(t)
	if st.Output == nil {
		t.Fatalf("STARTED %+v has no output", st)
	}
	return st, *st.Output
}

// data reads STDOUT until it holds n bytes, and fails on any other frame.
func (h *host) data(t *testing.T, n int) []byte {
	t.Helper()
	for h.out.Len() < n {
		f := h.next(t)
		if f.Type != proto.TypeStdout {
			t.Fatalf("got %s %q after %d of %d bytes", f.Type, f.Payload, h.out.Len(), n)
		}
		h.out.Write(f.Payload)
	}
	return h.out.Bytes()
}

// wire is a resume as the agent sends it: each kind with its own fields
func wire(t *testing.T, r *proto.Resume) string {
	t.Helper()
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func resumeFrom(t *testing.T, m *Manager, name string, generation string, offset uint64) *host {
	t.Helper()
	return connect(t, m, proto.Request{Op: proto.OpSessionAttach, Session: name, Cols: 80, Rows: 24,
		ResumeFrom: &proto.ResumeFrom{Generation: generation, Offset: offset}})
}

// startQuiet starts a session that writes exactly what script prints, with
// no newline translation or echo, then waits for its output to reach n
// bytes with no viewer attached.
func startQuiet(t *testing.T, m *Manager, name, script string, n uint64) proto.Output {
	t.Helper()
	h := start(t, m, name, "stty -opost -echo; "+script+"; exec sleep 60")
	_, out := h.output(t)
	h.detach(t)
	waitFor(t, "the output", func() bool {
		info, _ := find(m, name)
		return info.End == n
	})
	return out
}

// A fresh attach sends the history's replay as before offsets, as one frame
// (TestHistoryReplayMatchesTheGolden pins the history), and places it:
// offset is its first byte after the prelude.
func TestFreshAttachSendsTheReplay(t *testing.T) {
	m := newTestManager(t)
	fixture := bytes.Join(goldenOutput(), nil)
	path := filepath.Join(t.TempDir(), "output")
	if err := os.WriteFile(path, fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	first := startQuiet(t, m, "main", "cat "+path, uint64(len(fixture)))
	if !generationPattern.MatchString(first.Generation) || first.BootID != testBootID {
		t.Fatalf("output %+v: want a 32-hex generation and the boot id", first)
	}
	m.mu.Lock()
	s := m.sessions["main"]
	m.mu.Unlock()
	s.mu.Lock()
	want := replay(s.screen)
	s.mu.Unlock()

	h := attach(t, m, "main")
	_, out := h.output(t)
	f := h.next(t)
	if f.Type != proto.TypeStdout || !bytes.Equal(f.Payload, want) {
		t.Fatalf("replay frame %s of %d bytes, want the history's %d", f.Type, len(f.Payload), len(want))
	}
	kept := uint64(len(f.Payload) - out.Prelude)
	if out.Resume != nil || out.End != uint64(len(fixture)) || out.Offset != out.End-kept || out.Prelude == 0 {
		t.Fatalf("output %+v for a replay of %d bytes", out, len(f.Payload))
	}
	if !bytes.Equal(f.Payload[out.Prelude:], fixture[out.Offset:]) {
		t.Fatal("the replay after the prelude is not the output from its offset")
	}
	if out.BufferStart != out.End-ringSize || out.Generation != first.Generation {
		t.Fatalf("output %+v, want the ring to hold exactly %d bytes", out, ringSize)
	}
}

// The ring holds exactly ringSize bytes even when its start falls inside an
// escape sequence, which a fresh replay would skip.
func TestBufferStartIsExactInsideASequence(t *testing.T) {
	m := newTestManager(t)
	// an OSC string that never ends: a fresh replay finds no ground state
	n := uint64(ringSize + 1000)
	startQuiet(t, m, "main", `printf '\033]0;'; head -c `+strconv.FormatUint(n-4, 10)+` /dev/zero | tr '\0' t`, n)

	h := attach(t, m, "main")
	_, out := h.output(t)
	if out.BufferStart != n-ringSize || out.End != n {
		t.Fatalf("output %+v, want buffer start %d", out, n-ringSize)
	}

	r := resumeFrom(t, m, "main", out.Generation, out.BufferStart)
	_, resumed := r.output(t)
	if resumed.Resume == nil || resumed.Resume.Kind != proto.ResumeExact || resumed.Prelude != 0 {
		t.Fatalf("resume at the buffer start: %+v", resumed)
	}
	if got := r.data(t, ringSize); !bytes.Equal(got, bytes.Repeat([]byte("t"), ringSize)) {
		t.Fatalf("resumed %d bytes, want %d raw ones", len(got), ringSize)
	}
}

func TestResumeExact(t *testing.T) {
	m := newTestManager(t)
	out := startQuiet(t, m, "main", "printf 0123456789", 10)

	h := resumeFrom(t, m, "main", out.Generation, 4)
	st, resumed := h.output(t)
	if st.Created || resumed.Resume == nil || resumed.Resume.Kind != proto.ResumeExact {
		t.Fatalf("STARTED %+v output %+v, want an exact resume", st, resumed)
	}
	if resumed.Offset != 4 || resumed.Prelude != 0 || resumed.End != 10 || resumed.BufferStart != 0 {
		t.Fatalf("output %+v", resumed)
	}
	if got := wire(t, resumed.Resume); got != `{"kind":"exact"}` {
		t.Fatalf("resume %s, want exact alone", got)
	}
	if got := string(h.data(t, 6)); got != "456789" {
		t.Fatalf("data %q, want 456789", got)
	}

	// at the end: nothing to send, live output follows
	again := resumeFrom(t, m, "main", out.Generation, 10)
	if _, at := again.output(t); at.Resume.Kind != proto.ResumeExact || at.Offset != 10 {
		t.Fatalf("resume at the end: %+v", at)
	}
}

func TestResumeGap(t *testing.T) {
	m := newTestManager(t)
	const n = 1 << 20
	out := startQuiet(t, m, "main", "head -c 1048576 /dev/zero | tr '\\0' g", n)

	h := resumeFrom(t, m, "main", out.Generation, 0)
	_, resumed := h.output(t)
	want := `{"kind":"gap","from":0,"to":` + strconv.Itoa(n-ringSize) + `}`
	if got := wire(t, resumed.Resume); got != want || resumed.Offset != n-ringSize || resumed.Prelude != 0 {
		t.Fatalf("resume %s offset %d, want %s", got, resumed.Offset, want)
	}
	if got := h.data(t, ringSize); len(got) != ringSize {
		t.Fatalf("data is %d bytes, want %d", len(got), ringSize)
	}
}

func TestResumeGenerationChanged(t *testing.T) {
	m := newTestManager(t)
	out := startQuiet(t, m, "main", "printf abc", 3)

	other := strings.Repeat("0", 32)
	h := resumeFrom(t, m, "main", other, 1)
	_, resumed := h.output(t)
	want := `{"kind":"generation_changed","execution_generation":"` + out.Generation + `","first_offset":0}`
	if got := wire(t, resumed.Resume); got != want || resumed.Offset != 0 {
		t.Fatalf("resume %s offset %d, want %s", got, resumed.Offset, want)
	}
	if got := string(h.data(t, 3)); got != "abc" {
		t.Fatalf("data %q", got)
	}
}

// A resume past the end is a client bug: an error with the place, and the
// viewer attached keeps the session.
func TestResumePastTheEnd(t *testing.T) {
	m := newTestManager(t)
	out := startQuiet(t, m, "main", "printf abc", 3)
	viewer := attach(t, m, "main")
	viewer.output(t)

	h := resumeFrom(t, m, "main", out.Generation, 4)
	resp := decode[struct {
		Error struct {
			Code string                  `json:"code"`
			Data proto.InvalidResumeData `json:"data"`
		} `json:"error"`
	}](t, h.next(t))
	if resp.Error.Code != proto.ErrInvalidResume || resp.Error.Data != (proto.InvalidResumeData{End: 3, BufferStart: 0}) {
		t.Fatalf("error %+v, want INVALID_RESUME with end 3", resp.Error)
	}
	if info, _ := find(m, "main"); !info.Attached {
		t.Fatal("the attached viewer lost the session")
	}
}

// A start with a resume for a name with no process starts one, from 0.
func TestStartWithResumeStartsAGeneration(t *testing.T) {
	m := newTestManager(t)
	h := connect(t, m, proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"sleep", "60"},
		ResumeFrom: &proto.ResumeFrom{Generation: strings.Repeat("a", 32), Offset: 7}})
	st, out := h.output(t)
	if !st.Created || out.Resume == nil || out.Resume.Kind != proto.ResumeGenerationChanged || out.Resume.FirstOffset == nil || *out.Resume.FirstOffset != 0 || out.Resume.Generation != out.Generation {
		t.Fatalf("STARTED %+v output %+v", st, out)
	}
}

// A resume of a generation that exited, whose EXIT no viewer got, attaches
// to it: the tail, then the EXIT. A start without one replaces it.
func TestResumeOfAnExitedGeneration(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", "stty -opost; printf 'one two'; sleep 0.3; exit 3")
	_, out := h.output(t)
	h.detach(t)
	waitFor(t, "the exit", func() bool {
		info, _ := find(m, "job")
		return info.State == proto.SessionExited
	})

	r := connect(t, m, proto.Request{Op: proto.OpExec, Session: "job", TTY: true, Argv: []string{"sleep", "60"},
		ResumeFrom: &proto.ResumeFrom{Generation: out.Generation, Offset: 4}})
	st, resumed := r.output(t)
	if st.Created || resumed.Generation != out.Generation || resumed.Resume.Kind != proto.ResumeExact {
		t.Fatalf("STARTED %+v output %+v, want the exited generation", st, resumed)
	}
	if exit := decode[proto.Exit](t, r.last(t)); exit.Code != 3 || r.out.String() != "two" {
		t.Fatalf("exit %+v after %q", exit, r.out.String())
	}
}

func TestPreviousAfterAReplacement(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", "stty -opost; printf done; exit 5")
	_, first := h.output(t)
	h.detach(t)
	waitFor(t, "the exit", func() bool {
		info, _ := find(m, "job")
		return info.State == proto.SessionExited
	})

	next := start(t, m, "job", "sleep 60")
	st, out := next.output(t)
	want := proto.Previous{Generation: first.Generation, End: 4, Exit: proto.Exit{Code: 5}}
	if !st.Created || out.Previous == nil || *out.Previous != want || out.Generation == first.Generation {
		t.Fatalf("output %+v, want previous %+v", out, want)
	}
}

// previous is written once the process ends, not at the kill, so its end
// and exit are final; a killed process that outlives its replacement's own
// end does not hide the replacement.
func TestPreviousIsFinalAfterAKill(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `trap '' HUP; stty -opost; printf ready; while :; do sleep 0.05; done`)
	killed, _ := h.output(t)
	h.until(t, "ready")
	h.detach(t)
	if err := m.Kill("job"); err != nil {
		t.Fatal(err)
	}
	if p := m.previousOf("job"); p != nil {
		t.Fatalf("previous %+v while the killed process runs", p)
	}

	// the name is free at once; the replacement ends first
	b := start(t, m, "job", "stty -opost; printf b; exit 2")
	_, second := b.output(t)
	if exit := decode[proto.Exit](t, b.last(t)); exit.Code != 2 {
		t.Fatalf("exit %+v", exit)
	}
	b.detach(t)
	waitFor(t, "the replacement as previous", func() bool {
		p := m.previousOf("job")
		return p != nil && p.Generation == second.Generation
	})

	// SIGKILL after the kill grace; the older run must not take over
	waitFor(t, "the killed process", func() bool { return syscall.Kill(killed.Pid, 0) != nil })
	if p := m.previousOf("job"); p.Generation != second.Generation || p.End != 1 || p.Exit.Code != 2 {
		t.Fatalf("previous %+v, want the replacement %s", p, second.Generation)
	}
}

// NO_SESSION carries the boot and the name's previous generation.
func TestNoSessionData(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", "exit 0")
	_, out := h.output(t)
	h.last(t)
	h.detach(t)
	waitFor(t, "the name to free", func() bool { _, ok := find(m, "job"); return !ok })

	resp := decode[struct {
		Error struct {
			Code string              `json:"code"`
			Data proto.NoSessionData `json:"data"`
		} `json:"error"`
	}](t, attach(t, m, "job").next(t))
	data := resp.Error.Data
	if resp.Error.Code != proto.ErrNoSession || data.BootID != testBootID || data.Previous == nil || data.Previous.Generation != out.Generation {
		t.Fatalf("error %+v", resp.Error)
	}
	if data := m.noSession("other").Data.(proto.NoSessionData); data.Previous != nil {
		t.Fatalf("a name that never ran has previous %+v", data.Previous)
	}
}
