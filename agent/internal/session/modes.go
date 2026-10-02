package session

import (
	"strconv"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/parser"
)

// DEC private modes that change how the terminal reads input or which
// screen it shows. A viewer's terminal must be in the same modes as the
// session, or keys, the mouse and pastes arrive in the wrong form.
var trackedModes = []int{
	1,    // DECCKM: application cursor keys
	25,   // DECTCEM: cursor visible (on by default)
	47,   // alternate screen
	1047, // alternate screen, cleared on exit
	1049, // alternate screen, with the cursor saved
	9,    // X10 mouse
	1000, // mouse button events
	1002, // mouse drag events
	1003, // all mouse motion
	1004, // focus in and out events
	1005, // UTF-8 mouse coordinates
	1006, // SGR mouse coordinates
	1015, // urxvt mouse coordinates
	1016, // SGR mouse coordinates in pixels
	2004, // bracketed paste
}

// defaultOn lists the tracked modes a terminal starts with set.
var defaultOn = map[int]bool{25: true}

// maxKittyFlags bounds the kitty keyboard flag stack, as kitty does.
const maxKittyFlags = 32

// parserDataSize bounds what the parser keeps of an OSC, DCS or APC string.
// The modes never need the string data; the parser still steps through it.
const parserDataSize = 64

// modes follows a terminal's input and screen modes through the bytes a
// program writes, with a VT parser so a sequence split across writes, or
// inside an OSC string, is read right.
type modes struct {
	parser *ansi.Parser
	set    map[int]bool
	// kitty is the kitty keyboard protocol's stack of flag sets; the last
	// entry is in effect.
	kitty []int
}

func newModes() *modes {
	m := &modes{parser: ansi.NewParser()}
	m.parser.SetDataSize(parserDataSize)
	m.parser.SetHandler(ansi.Handler{HandleCsi: m.handleCsi, HandleEsc: m.handleEsc})
	m.reset()
	return m
}

func (m *modes) reset() {
	m.set = make(map[int]bool, len(trackedModes))
	for _, n := range trackedModes {
		m.set[n] = defaultOn[n]
	}
	m.kitty = nil
}

func (m *modes) advance(b byte) { m.parser.Advance(b) }

// atGround reports whether the parser is between sequences and characters,
// where a byte stream can be cut and replayed from.
func (m *modes) atGround() bool { return m.parser.State() == parser.GroundState }

func (m *modes) handleCsi(cmd ansi.Cmd, params ansi.Params) {
	switch {
	case cmd.Prefix() == '?' && cmd.Intermediate() == 0 && (cmd.Final() == 'h' || cmd.Final() == 'l'):
		on := cmd.Final() == 'h'
		params.ForEach(-1, func(_, n int, _ bool) {
			if _, ok := m.set[n]; ok {
				m.set[n] = on
			}
		})
	case cmd.Intermediate() == '!' && cmd.Final() == 'p':
		// DECSTR, a soft reset: cursor keys normal, cursor visible.
		m.set[1] = false
		m.set[25] = true
	case cmd.Final() == 'u' && cmd.Intermediate() == 0:
		m.handleKitty(cmd.Prefix(), params)
	}
}

// handleKitty applies CSI > flags u (push), CSI < n u (pop) and
// CSI = flags ; mode u (set the flags in effect).
func (m *modes) handleKitty(prefix byte, params ansi.Params) {
	first, _, _ := params.Param(0, -1)
	switch prefix {
	case '>':
		if len(m.kitty) == maxKittyFlags {
			m.kitty = m.kitty[1:]
		}
		m.kitty = append(m.kitty, max(first, 0))
	case '<':
		n := max(first, 1)
		m.kitty = m.kitty[:max(len(m.kitty)-n, 0)]
	case '=':
		mode, _, _ := params.Param(1, 1)
		flags := max(first, 0)
		if len(m.kitty) == 0 {
			m.kitty = []int{0}
		}
		top := &m.kitty[len(m.kitty)-1]
		switch mode {
		case 1:
			*top = flags
		case 2:
			*top |= flags
		case 3:
			*top &^= flags
		}
	}
}

func (m *modes) handleEsc(cmd ansi.Cmd) {
	// RIS, a full reset
	if cmd.Intermediate() == 0 && cmd.Final() == 'c' {
		m.reset()
	}
}

// sequence returns the bytes that put a terminal in its default modes into
// these modes.
func (m *modes) sequence() []byte {
	var b strings.Builder
	for _, n := range trackedModes {
		if m.set[n] == defaultOn[n] {
			continue
		}
		b.WriteString("\x1b[?" + strconv.Itoa(n))
		if m.set[n] {
			b.WriteByte('h')
		} else {
			b.WriteByte('l')
		}
	}
	for _, flags := range m.kitty {
		b.WriteString("\x1b[>" + strconv.Itoa(flags) + "u")
	}
	return []byte(b.String())
}
