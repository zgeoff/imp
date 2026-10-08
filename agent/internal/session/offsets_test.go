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

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/proto"
)

const testBootID = "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11"

var generationPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// output reads the STARTED's output, which a session connection always has.
func (h *host) output(t *testing.T) (proto.Started, proto.Output) {
	t.Helper()
	st := h.started(t)
	assert.Assert(t, st.Output != nil, "STARTED %+v has no output", st)
	return st, *st.Output
}

// data reads STDOUT until it holds n bytes, and fails on any other frame.
func (h *host) data(t *testing.T, n int) []byte {
	t.Helper()
	for h.out.Len() < n {
		f := h.next(t)
		assert.Assert(t, cmp.Equal(f.Type, proto.TypeStdout), "%q after %d of %d bytes", f.Payload, h.out.Len(), n)
		h.out.Write(f.Payload)
	}
	return h.out.Bytes()
}

// wire is a resume as the agent sends it: each kind with its own fields
func wire(t *testing.T, r *proto.Resume) string {
	t.Helper()
	b, err := json.Marshal(r)
	assert.NilError(t, err)
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

func TestStartReportsAGenerationAndTheBootID(t *testing.T) {
	m := newTestManager(t)

	h := start(t, m, "main", "exec sleep 60")

	_, out := h.output(t)
	assert.Check(t, cmp.Regexp(generationPattern, out.Generation))
	assert.Check(t, cmp.Equal(out.BootID, testBootID))
}

// A fresh attach sends the history's replay as before offsets, as one frame
// (TestHistoryReplayMatchesTheGolden pins the history), and places it:
// offset is its first byte after the prelude.
func TestFreshAttachSendsTheReplayAndPlacesIt(t *testing.T) {
	m := newTestManager(t)
	fixture := bytes.Join(goldenOutput(), nil)
	path := filepath.Join(t.TempDir(), "output")
	assert.NilError(t, os.WriteFile(path, fixture, 0o600))
	first := startQuiet(t, m, "main", "cat "+path, uint64(len(fixture)))
	m.mu.Lock()
	s := m.sessions["main"]
	m.mu.Unlock()
	s.mu.Lock()
	// Screen.Replay is a separate unit that TestHistoryReplayMatchesTheGolden
	// pins, so here it is a tested collaborator, not the unit under test.
	want := replay(s.screen)
	s.mu.Unlock()

	h := attach(t, m, "main")

	_, out := h.output(t)
	f := h.next(t)
	assert.Assert(t, cmp.Equal(f.Type, proto.TypeStdout))
	assert.Assert(t, bytes.Equal(f.Payload, want), "replay frame of %d bytes, want the history's %d", len(f.Payload), len(want))
	assert.Assert(t, out.Prelude <= len(f.Payload), "a prelude of %d in a frame of %d", out.Prelude, len(f.Payload))
	kept := uint64(len(f.Payload) - out.Prelude)
	assert.Check(t, cmp.Nil(out.Resume))
	assert.Check(t, cmp.Equal(out.End, uint64(len(fixture))))
	assert.Check(t, cmp.Equal(out.Offset, out.End-kept))
	assert.Check(t, out.Prelude != 0, "the replay has a prelude")
	assert.Check(t, bytes.Equal(f.Payload[out.Prelude:], fixture[out.Offset:]), "the replay after the prelude is not the output from its offset")
	assert.Check(t, cmp.Equal(out.BufferStart, out.End-ringSize), "the ring holds exactly ringSize bytes")
	assert.Check(t, cmp.Equal(out.Generation, first.Generation))
}

// The ring holds exactly ringSize bytes even when its start falls inside an
// escape sequence, which a fresh replay would skip.
func TestFreshAttachReportsTheExactBufferStartInsideASequence(t *testing.T) {
	m := newTestManager(t)
	// an OSC string that never ends: a fresh replay finds no ground state
	n := uint64(ringSize + 1000)
	startQuiet(t, m, "main", `printf '\033]0;'; head -c `+strconv.FormatUint(n-4, 10)+` /dev/zero | tr '\0' t`, n)

	h := attach(t, m, "main")

	_, out := h.output(t)
	assert.Check(t, cmp.Equal(out.BufferStart, n-ringSize))
	assert.Check(t, cmp.Equal(out.End, n))
}

func TestResumeAtTheBufferStartInsideASequenceReadsTheRawRing(t *testing.T) {
	m := newTestManager(t)
	n := uint64(ringSize + 1000)
	first := startQuiet(t, m, "main", `printf '\033]0;'; head -c `+strconv.FormatUint(n-4, 10)+` /dev/zero | tr '\0' t`, n)

	r := resumeFrom(t, m, "main", first.Generation, n-ringSize)

	_, resumed := r.output(t)
	assert.Assert(t, resumed.Resume != nil, "resume at the buffer start: %+v", resumed)
	assert.Check(t, cmp.Equal(resumed.Resume.Kind, proto.ResumeExact))
	assert.Check(t, cmp.Equal(resumed.Prelude, 0))
	assert.Check(t, bytes.Equal(r.data(t, ringSize), bytes.Repeat([]byte("t"), ringSize)), "resumed bytes are not the %d raw ones", ringSize)
}

func TestResumeInsideTheRingIsExact(t *testing.T) {
	m := newTestManager(t)
	out := startQuiet(t, m, "main", "printf 0123456789", 10)

	h := resumeFrom(t, m, "main", out.Generation, 4)

	st, resumed := h.output(t)
	assert.Check(t, !st.Created, "the resume attached")
	assert.Check(t, cmp.Equal(wire(t, resumed.Resume), `{"kind":"exact"}`), "exact alone")
	assert.Check(t, cmp.Equal(resumed.Offset, uint64(4)))
	assert.Check(t, cmp.Equal(resumed.Prelude, 0))
	assert.Check(t, cmp.Equal(resumed.End, uint64(10)))
	assert.Check(t, cmp.Equal(resumed.BufferStart, uint64(0)))
	assert.Check(t, cmp.Equal(string(h.data(t, 6)), "456789"))
}

// At the end there is nothing to send; live output follows.
func TestResumeAtTheEndIsExact(t *testing.T) {
	m := newTestManager(t)
	out := startQuiet(t, m, "main", "printf 0123456789", 10)

	again := resumeFrom(t, m, "main", out.Generation, 10)

	_, at := again.output(t)
	assert.Check(t, cmp.Equal(wire(t, at.Resume), `{"kind":"exact"}`))
	assert.Check(t, cmp.Equal(at.Offset, uint64(10)))
}

func TestResumeBelowTheRingIsAGap(t *testing.T) {
	m := newTestManager(t)
	const n = 1 << 20
	out := startQuiet(t, m, "main", "head -c 1048576 /dev/zero | tr '\\0' g", n)

	h := resumeFrom(t, m, "main", out.Generation, 0)

	_, resumed := h.output(t)
	assert.Check(t, cmp.Equal(wire(t, resumed.Resume), `{"kind":"gap","from":0,"to":`+strconv.Itoa(n-ringSize)+`}`))
	assert.Check(t, cmp.Equal(resumed.Offset, uint64(n-ringSize)))
	assert.Check(t, cmp.Equal(resumed.Prelude, 0))
	assert.Check(t, cmp.Len(h.data(t, ringSize), ringSize))
}

func TestResumeOfAnotherGenerationReadsFromTheStart(t *testing.T) {
	m := newTestManager(t)
	out := startQuiet(t, m, "main", "printf abc", 3)

	h := resumeFrom(t, m, "main", strings.Repeat("0", 32), 1)

	_, resumed := h.output(t)
	assert.Check(t, cmp.Equal(wire(t, resumed.Resume), `{"kind":"generation_changed","execution_generation":"`+out.Generation+`","first_offset":0}`))
	assert.Check(t, cmp.Equal(resumed.Offset, uint64(0)))
	assert.Check(t, cmp.Equal(string(h.data(t, 3)), "abc"))
}

// A resume past the end is a client bug: an error with the place, and the
// viewer attached keeps the session.
func TestResumePastTheEndIsInvalidAndKeepsTheViewer(t *testing.T) {
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
	assert.Check(t, cmp.Equal(resp.Error.Code, proto.ErrInvalidResume))
	assert.Check(t, cmp.Equal(resp.Error.Data, proto.InvalidResumeData{End: 3, BufferStart: 0}))
	info, _ := find(m, "main")
	assert.Check(t, info.Attached, "the attached viewer lost the session")
}

// A start with a resume for a name with no process starts one, from 0.
func TestStartWithAResumeStartsAGenerationFromZero(t *testing.T) {
	m := newTestManager(t)

	h := connect(t, m, proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"sleep", "60"},
		ResumeFrom: &proto.ResumeFrom{Generation: strings.Repeat("a", 32), Offset: 7}})

	st, out := h.output(t)
	assert.Check(t, st.Created)
	assert.Check(t, cmp.Equal(wire(t, out.Resume), `{"kind":"generation_changed","execution_generation":"`+out.Generation+`","first_offset":0}`))
}

// A resume of a generation that exited, whose EXIT no viewer got, attaches
// to it: the tail, then the EXIT.
func TestResumeOfAnExitedGenerationGetsTheTailThenTheExit(t *testing.T) {
	m := newTestManager(t)
	ready := filepath.Join(t.TempDir(), "go")
	h := start(t, m, "job", "stty -opost; printf 'one two'; "+waitOnFile(ready)+"; exit 3")
	_, out := h.output(t)
	h.detach(t)
	touch(t, ready)
	waitFor(t, "the exit", func() bool {
		info, _ := find(m, "job")
		return info.State == proto.SessionExited
	})

	r := connect(t, m, proto.Request{Op: proto.OpExec, Session: "job", TTY: true, Argv: []string{"sleep", "60"},
		ResumeFrom: &proto.ResumeFrom{Generation: out.Generation, Offset: 4}})

	st, resumed := r.output(t)
	assert.Check(t, !st.Created, "the resume attached to the exited generation")
	assert.Check(t, cmp.Equal(resumed.Generation, out.Generation))
	assert.Check(t, cmp.Equal(wire(t, resumed.Resume), `{"kind":"exact"}`))
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, r.last(t)), proto.Exit{Code: 3}))
	assert.Check(t, cmp.Equal(r.out.String(), "two"))
}

// A start without a resume replaces an exited generation, and reports it as
// the name's previous one.
func TestStartAfterAnExitReportsThePreviousGeneration(t *testing.T) {
	m := newTestManager(t)
	ready := filepath.Join(t.TempDir(), "go")
	h := start(t, m, "job", "stty -opost; printf done; "+waitOnFile(ready)+"; exit 5")
	_, first := h.output(t)
	h.detach(t)
	touch(t, ready)
	waitFor(t, "the exit", func() bool {
		info, _ := find(m, "job")
		return info.State == proto.SessionExited
	})

	next := start(t, m, "job", "sleep 60")

	st, out := next.output(t)
	assert.Check(t, st.Created)
	assert.Check(t, cmp.DeepEqual(out.Previous, &proto.Previous{Generation: first.Generation, End: 4, Exit: proto.Exit{Code: 5}}))
	assert.Check(t, out.Generation != first.Generation, "the replacement has a generation of its own")
}

// previous is written once the process ends, not at the kill.
func TestPreviousIsUnsetWhileAKilledProcessRuns(t *testing.T) {
	m := newTestManager(t)
	h := start(t, m, "job", `trap '' HUP; stty -opost; printf ready; while :; do sleep 0.05; done`)
	h.output(t)
	h.until(t, "ready")
	h.detach(t)

	assert.NilError(t, m.Kill("job"))

	assert.Check(t, cmp.Nil(m.previousOf("job")))
}

// previous is final: a killed process that outlives its replacement's own
// end does not hide the replacement.
func TestPreviousIsFinalAfterAKill(t *testing.T) {
	// It waits out the real kill grace; it owns its manager and changes no
	// package setting, so it waits beside the other such test.
	t.Parallel()
	m := newTestManager(t)
	h := start(t, m, "job", `trap '' HUP; stty -opost; printf ready; while :; do sleep 0.05; done`)
	killed, _ := h.output(t)
	h.until(t, "ready")
	h.detach(t)
	assert.NilError(t, m.Kill("job"))
	// the name is free at once; the replacement ends first
	b := start(t, m, "job", "stty -opost; printf b; exit 2")
	_, second := b.output(t)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, b.last(t)), proto.Exit{Code: 2}))
	b.detach(t)
	waitFor(t, "the replacement as previous", func() bool {
		p := m.previousOf("job")
		return p != nil && p.Generation == second.Generation
	})

	// SIGKILL after the kill grace; the older run must not take over
	waitFor(t, "the killed process", func() bool { return syscall.Kill(killed.Pid, 0) != nil })

	assert.Check(t, cmp.DeepEqual(m.previousOf("job"), &proto.Previous{Generation: second.Generation, End: 1, Exit: proto.Exit{Code: 2}}))
}

// NO_SESSION carries the boot and the name's previous generation.
func TestNoSessionCarriesTheBootAndThePreviousGeneration(t *testing.T) {
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

	assert.Check(t, cmp.Equal(resp.Error.Code, proto.ErrNoSession))
	assert.Check(t, cmp.Equal(resp.Error.Data.BootID, testBootID))
	assert.Assert(t, resp.Error.Data.Previous != nil)
	assert.Check(t, cmp.Equal(resp.Error.Data.Previous.Generation, out.Generation))
}

func TestNoSessionForANameThatNeverRanHasNoPrevious(t *testing.T) {
	m := newTestManager(t)

	data := m.noSession("other").Data.(proto.NoSessionData)

	assert.Check(t, cmp.Nil(data.Previous))
}
