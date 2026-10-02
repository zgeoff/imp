package session

import "testing"

func TestModesSequence(t *testing.T) {
	tests := []struct {
		name   string
		writes []string
		want   string
	}{
		{"defaults", nil, ""},
		{"alt screen, mouse, paste", []string{"\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h"},
			"\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h"},
		{"cursor keys, hidden cursor, focus", []string{"\x1b[?1h\x1b[?25l\x1b[?1004h"},
			"\x1b[?1h\x1b[?25l\x1b[?1004h"},
		{"set then reset", []string{"\x1b[?1049h\x1b[?2004h", "\x1b[?1049l\x1b[?2004l"}, ""},
		{"untracked modes are ignored", []string{"\x1b[?7l\x1b[?12h\x1b[4h"}, ""},
		{"a sequence split across writes", []string{"\x1b[?10", "49h"}, "\x1b[?1049h"},
		{"inside an OSC string", []string{"\x1b]0;[?1049h title\x07"}, ""},
		{"after an OSC string", []string{"\x1b]0;title\x07\x1b[?2004h"}, "\x1b[?2004h"},
		{"RIS resets everything", []string{"\x1b[?1049h\x1b[>1u", "\x1bc"}, ""},
		{"DECSTR resets cursor keys and the cursor", []string{"\x1b[?1h\x1b[?25l\x1b[?2004h\x1b[!p"},
			"\x1b[?2004h"},
		{"kitty push and pop", []string{"\x1b[>1u\x1b[>3u\x1b[>5u\x1b[<2u"}, "\x1b[>1u"},
		{"kitty pop more than pushed", []string{"\x1b[>1u\x1b[<5u"}, ""},
		{"kitty set modes", []string{"\x1b[>1u\x1b[=4;2u\x1b[=1;3u"}, "\x1b[>4u"},
		{"kitty set with an empty stack", []string{"\x1b[=8u"}, "\x1b[>8u"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newModes()
			for _, w := range tt.writes {
				for _, b := range []byte(w) {
					m.advance(b)
				}
			}
			if got := string(m.sequence()); got != tt.want {
				t.Errorf("sequence %q, want %q", got, tt.want)
			}
		})
	}
}

func TestModesKittyStackIsBounded(t *testing.T) {
	m := newModes()
	for range maxKittyFlags + 10 {
		for _, b := range []byte("\x1b[>1u") {
			m.advance(b)
		}
	}
	if len(m.kitty) != maxKittyFlags {
		t.Fatalf("stack depth %d, want %d", len(m.kitty), maxKittyFlags)
	}
}

func TestModesGround(t *testing.T) {
	m := newModes()
	steps := []struct {
		b      byte
		ground bool
	}{
		{'a', true},
		{0x1b, false},
		{'[', false},
		{'m', true},
		{0xc3, false}, // the first byte of a two-byte UTF-8 character
		{0xa9, true},
	}
	for i, s := range steps {
		m.advance(s.b)
		if m.atGround() != s.ground {
			t.Fatalf("after byte %d (%#x): atGround %v, want %v", i, s.b, m.atGround(), s.ground)
		}
	}
}
