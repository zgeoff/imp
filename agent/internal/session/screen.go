package session

// Screen keeps what a viewer that attaches later needs to see the session's
// terminal. A terminal emulator that keeps the cell grid could replace
// history and give an exact redraw; history keeps the raw output instead.
type Screen interface {
	// Write takes the program's output, in order.
	Write(p []byte)
	// Replay returns the bytes that bring a terminal in its default modes
	// up to date.
	Replay() []byte
}

// history is a Screen that keeps the last stretch of raw output. Its replay
// is the modes in effect where that stretch starts, then the stretch, so the
// terminal ends in the modes the program last set. The replay shows the
// output as it was written, at the width it was written for; a full-screen
// program draws itself again when the viewer's resize sends SIGWINCH.
type history struct {
	// limit is the least output kept once that much was written; buf holds
	// up to twice that before it drops the oldest part, so dropping costs
	// one copy per limit bytes written.
	limit int
	buf   []byte
	// start follows the bytes that were dropped: it holds the modes in
	// effect where buf starts.
	start *modes
}

func newHistory(limit int) *history {
	return &history{limit: limit, buf: make([]byte, 0, 2*limit), start: newModes()}
}

func (h *history) Write(p []byte) {
	if len(h.buf)+len(p) <= 2*h.limit {
		h.buf = append(h.buf, p...)
		return
	}
	h.buf = append(h.buf, p...)
	h.trim()
}

// trim drops the oldest output down to limit bytes, then further to the
// next point where the parser is between sequences: a replay that started
// inside an escape sequence or a UTF-8 character would show garbage.
func (h *history) trim() {
	cut := len(h.buf) - h.limit
	for _, b := range h.buf[:cut] {
		h.start.advance(b)
	}
	for cut < len(h.buf) && !h.start.atGround() {
		h.start.advance(h.buf[cut])
		cut++
	}
	n := copy(h.buf, h.buf[cut:])
	h.buf = h.buf[:n]
	if cap(h.buf) > 2*h.limit {
		// a single write larger than the buffer grew it; give that back
		h.buf = append(make([]byte, 0, 2*h.limit), h.buf...)
	}
}

func (h *history) Replay() []byte {
	prefix := h.start.sequence()
	out := make([]byte, 0, len(prefix)+len(h.buf))
	return append(append(out, prefix...), h.buf...)
}
