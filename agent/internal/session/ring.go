package session

// ringSize is the raw output a resume can read back: exactly the last this
// many bytes of a generation.
const ringSize = 256 << 10

// ring keeps exactly the last size bytes written, or all of them while
// fewer were written, and counts every byte, so a place in the output is
// an offset. It grows toward size as output arrives, never past it, then
// wraps.
type ring struct {
	size int
	buf  []byte
	// head is where the next byte goes once buf is full
	head int
	// end is the offset after the last byte written
	end uint64
}

func newRing(size int) *ring { return &ring{size: size} }

func (r *ring) Write(p []byte) {
	r.end += uint64(len(p))
	if len(p) >= r.size {
		r.grow(r.size)
		r.buf = append(r.buf[:0], p[len(p)-r.size:]...)
		r.head = 0
		return
	}
	if room := r.size - len(r.buf); room > 0 {
		n := min(room, len(p))
		r.grow(len(r.buf) + n)
		r.buf = append(r.buf, p[:n]...)
		p = p[n:]
	}
	for len(p) > 0 {
		n := copy(r.buf[r.head:], p)
		r.head = (r.head + n) % r.size
		p = p[n:]
	}
}

// grow makes room for n bytes, doubling as append would but capped at
// size, so a full ring holds exactly size bytes of memory.
func (r *ring) grow(n int) {
	if n <= cap(r.buf) {
		return
	}
	buf := make([]byte, len(r.buf), min(r.size, max(n, 2*cap(r.buf))))
	copy(buf, r.buf)
	r.buf = buf
}

// End is the offset after the last byte written.
func (r *ring) End() uint64 { return r.end }

// Start is the offset of the oldest byte kept.
func (r *ring) Start() uint64 { return r.end - uint64(len(r.buf)) }

// From returns a copy of the bytes from offset off to the end. off must lie
// in [Start, End].
func (r *ring) From(off uint64) []byte {
	skip := int(off - r.Start())
	out := make([]byte, 0, len(r.buf)-skip)
	if skip == len(r.buf) {
		return out
	}
	if len(r.buf) < r.size {
		return append(out, r.buf[skip:]...)
	}
	// once full, the oldest byte is at head
	at := (r.head + skip) % r.size
	if at < r.head {
		return append(out, r.buf[at:r.head]...)
	}
	return append(append(out, r.buf[at:]...), r.buf[:r.head]...)
}
