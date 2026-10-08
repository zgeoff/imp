package session

import (
	"bytes"
	"slices"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestHistoryReplaysShortOutputWhole(t *testing.T) {
	h := newHistory(16)

	h.Write([]byte("hello "))
	h.Write([]byte("world"))

	assert.Equal(t, string(replay(h)), "hello world")
}

func TestHistoryDropsTheOldestOutputPastItsLimit(t *testing.T) {
	const limit = 64
	h := newHistory(limit)
	var all bytes.Buffer

	for i := range 100 {
		line := []byte(strings.Repeat(string(rune('a'+i%26)), 9) + "\n")
		all.Write(line)
		h.Write(line)
	}

	got := replay(h)
	assert.Check(t, len(got) >= limit && len(got) <= 2*limit, "replay is %d bytes, want %d to %d", len(got), limit, 2*limit)
	assert.Check(t, bytes.HasSuffix(all.Bytes(), got), "replay %q is not the end of the output", got)
}

// A cut inside an escape sequence or a UTF-8 character moves forward to the
// next point where the parser is between them.
func TestHistoryCutsBetweenSequences(t *testing.T) {
	tests := []struct {
		name string
		unit string
		// where in unit a replay may start
		starts []string
	}{
		{"SGR sequences", "\x1b[38;5;208mX", []string{"\x1b[38;5;208mX", "X"}},
		{"UTF-8 characters", "é€", []string{"é€", "€"}},
		{"OSC strings", "\x1b]0;a long window title\x07", []string{"\x1b]0;a long window title\x07"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHistory(50)

			for range 40 {
				h.Write([]byte(tt.unit))
			}

			got := string(replay(h))
			assert.Assert(t, slices.ContainsFunc(tt.starts, func(s string) bool { return strings.HasPrefix(got, s) }),
				"replay starts %q, inside %q", got[:min(len(got), 20)], tt.unit)
		})
	}
}

// The modes set in output that was dropped still lead the replay.
func TestHistoryReplaysDroppedModesFirst(t *testing.T) {
	h := newHistory(32)
	h.Write([]byte("\x1b[?1049h\x1b[?2004h\x1b[?1000h"))

	h.Write([]byte(strings.Repeat("x", 100)))

	got := string(replay(h))
	assert.Check(t, strings.HasPrefix(got, "\x1b[?1000h\x1b[?2004h\x1b[?1049h"), "replay %q does not lead with the dropped modes", got)
	assert.Check(t, cmp.Equal(strings.Count(got, "\x1b"), 3), "replay %q", got)
}

// A mode reset later in the kept output stays in the replay too, after the
// prefix, so the terminal ends in the program's current modes.
func TestHistoryKeepsALaterModeResetAfterTheDroppedModes(t *testing.T) {
	h := newHistory(32)
	h.Write([]byte("\x1b[?1049h\x1b[?2004h\x1b[?1000h"))
	h.Write([]byte(strings.Repeat("x", 100)))

	h.Write([]byte("\x1b[?2004l"))

	got := string(replay(h))
	assert.Check(t, strings.HasPrefix(got, "\x1b[?1000h\x1b[?2004h\x1b[?1049h"), "replay %q lost the dropped modes", got)
	assert.Check(t, strings.HasSuffix(got, "\x1b[?2004l"), "replay %q lost the later reset", got)
}

func TestHistoryKeepsOnlyItsLimitOfAWriteLargerThanTheBuffer(t *testing.T) {
	h := newHistory(16)

	h.Write(bytes.Repeat([]byte("y"), 1000))

	assert.Check(t, cmp.Len(replay(h), 16))
	assert.Check(t, cap(h.buf) <= 32, "buffer kept %d bytes of capacity", cap(h.buf))
}

// replay is a fresh attach's replay as one frame carries it.
func replay(s Screen) []byte {
	prelude, kept := s.Replay()
	return append(append([]byte(nil), prelude...), kept...)
}
