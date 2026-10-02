package session

import (
	"bytes"
	"slices"
	"strings"
	"testing"
)

func TestHistoryKeepsShortOutput(t *testing.T) {
	h := newHistory(16)
	h.Write([]byte("hello "))
	h.Write([]byte("world"))
	if got := string(replay(h)); got != "hello world" {
		t.Fatalf("replay %q", got)
	}
}

func TestHistoryDropsTheOldest(t *testing.T) {
	const limit = 64
	h := newHistory(limit)
	var all bytes.Buffer
	for i := range 100 {
		line := []byte(strings.Repeat(string(rune('a'+i%26)), 9) + "\n")
		all.Write(line)
		h.Write(line)
	}
	got := replay(h)
	if len(got) < limit || len(got) > 2*limit {
		t.Fatalf("replay is %d bytes, want %d to %d", len(got), limit, 2*limit)
	}
	if !bytes.HasSuffix(all.Bytes(), got) {
		t.Fatalf("replay %q is not the end of the output", got)
	}
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
			if !slices.ContainsFunc(tt.starts, func(s string) bool { return strings.HasPrefix(got, s) }) {
				t.Fatalf("replay starts %q, inside %q", got[:min(len(got), 20)], tt.unit)
			}
		})
	}
}

// The modes set in output that was dropped still lead the replay.
func TestHistoryReplaysDroppedModes(t *testing.T) {
	h := newHistory(32)
	h.Write([]byte("\x1b[?1049h\x1b[?2004h\x1b[?1000h"))
	h.Write([]byte(strings.Repeat("x", 100)))
	got := string(replay(h))
	want := "\x1b[?1000h\x1b[?2004h\x1b[?1049h"
	if !strings.HasPrefix(got, want) || strings.Count(got, "\x1b") != 3 {
		t.Fatalf("replay %q, want %q then the output", got, want)
	}
	// A mode reset later in the kept output stays in the replay too, after
	// the prefix, so the terminal ends in the program's current modes.
	h.Write([]byte("\x1b[?2004l"))
	if got := string(replay(h)); !strings.HasSuffix(got, "\x1b[?2004l") {
		t.Fatalf("replay %q lost the later reset", got)
	}
}

func TestHistoryWriteLargerThanTheBuffer(t *testing.T) {
	h := newHistory(16)
	big := bytes.Repeat([]byte("y"), 1000)
	h.Write(big)
	got := replay(h)
	if len(got) != 16 {
		t.Fatalf("replay is %d bytes, want 16", len(got))
	}
	if cap(h.buf) > 32 {
		t.Fatalf("buffer kept %d bytes of capacity", cap(h.buf))
	}
}

// replay is a fresh attach's replay as one frame carries it.
func replay(s Screen) []byte {
	prelude, kept := s.Replay()
	return append(append([]byte(nil), prelude...), kept...)
}
