package session

import (
	"testing"

	"gotest.tools/v3/assert"
)

func TestModesSequenceRestoresTheTrackedModesTheOutputLeftSet(t *testing.T) {
	tests := []struct {
		name   string
		writes []string
		want   string
	}{
		{"defaults", nil, ""},
		{"alt screen, mouse, paste", []string{"\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h"},
			"\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1049h"},
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
		{"kitty stacks per screen", []string{"\x1b[>1u\x1b[?1049h\x1b[>3u\x1b[>5u"},
			"\x1b[>1u\x1b[?1049h\x1b[>3u\x1b[>5u"},
		{"kitty pop on the alt screen leaves the main stack", []string{"\x1b[>1u\x1b[?1049h\x1b[>3u\x1b[<5u"},
			"\x1b[>1u\x1b[?1049h"},
		{"leaving the alt screen shows the main stack", []string{"\x1b[>1u\x1b[?1049h\x1b[>3u\x1b[?1049l\x1b[<1u"},
			"\x1b[>3u"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newModes()
			for _, w := range tt.writes {
				for _, b := range []byte(w) {
					m.advance(b)
				}
			}

			assert.Equal(t, string(m.sequence()), tt.want)
		})
	}
}

func TestModesBoundsTheKittyStackPastItsLimit(t *testing.T) {
	m := newModes()

	for range maxKittyFlags + 10 {
		for _, b := range []byte("\x1b[>1u") {
			m.advance(b)
		}
	}

	assert.Equal(t, len(m.kitty[0]), maxKittyFlags)
}

// Each step checks the transition its byte makes, so a failure names the
// byte that left or reached the ground state wrongly.
func TestModesReportsGroundOnlyBetweenSequencesAndCharacters(t *testing.T) {
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
		assert.Equal(t, m.atGround(), s.ground, "after byte %d (%#x)", i, s.b)
	}
}
