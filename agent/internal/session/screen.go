package session

// Screen keeps what a viewer that attaches later needs to see the session's
// terminal. A terminal emulator that keeps the cell grid could replace
// history and give an exact redraw; history keeps the raw output instead.
type Screen interface {
	// Write takes the program's output, in order.
	Write(p []byte)
	// Replay returns the bytes that bring a terminal in its default modes
	// up to date: a prelude of modes, then the kept output, which ends with
	// the last byte written.
	Replay() (prelude, kept []byte)
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
	if len(h.buf)+len(p) > 2*h.limit {
		// trim first, so buf never grows past its capacity
		p = h.drop(len(h.buf)+len(p)-h.limit, p)
	}
	h.buf = append(h.buf, p...)
}

// drop discards the oldest n bytes of buf followed by p, then further to the
// next point where the parser is between sequences: a replay that started
// inside an escape sequence or a UTF-8 character would show garbage. It
// returns what is left of p.
func (h *history) drop(n int, p []byte) []byte {
	k := min(n, len(h.buf))
	cut := h.skip(h.buf, k)
	ground := cut < len(h.buf)
	h.buf = h.buf[:copy(h.buf, h.buf[cut:])]
	if ground {
		return p
	}
	return p[h.skip(p, n-k):]
}

// skip feeds the first k bytes of b to start, then more up to the parser's
// next ground state, and returns how many it fed.
func (h *history) skip(b []byte, k int) int {
	for _, c := range b[:k] {
		h.start.advance(c)
	}
	for k < len(b) && !h.start.atGround() {
		h.start.advance(b[k])
		k++
	}
	return k
}

func (h *history) Replay() (prelude, kept []byte) {
	return h.start.sequence(), h.buf
}
