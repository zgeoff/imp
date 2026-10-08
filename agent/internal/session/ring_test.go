package session

import (
	"bytes"
	"math/rand/v2"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

// The ring holds exactly the last ringSize bytes, wherever the writes split,
// and From reads any offset it holds. The writes come from a fixed seed, so
// a failure replays; each step checks the invariants after its write.
func TestRingKeepsExactlyTheLastBytesWhereverTheWritesSplit(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	r := newRing(ringSize)
	var all []byte
	for len(all) < 3*ringSize {
		chunk := make([]byte, 1+rng.IntN(70000))
		for i := range chunk {
			chunk[i] = byte(rng.Uint32())
		}
		r.Write(chunk)
		all = append(all, chunk...)

		kept := min(len(all), ringSize)
		assert.Assert(t, cap(r.buf) <= ringSize, "after %d bytes: the ring holds %d bytes of memory, more than %d", len(all), cap(r.buf), ringSize)
		assert.Equal(t, r.End(), uint64(len(all)), "after %d bytes", len(all))
		assert.Equal(t, r.Start(), uint64(len(all)-kept), "after %d bytes", len(all))
		for _, off := range []uint64{r.Start(), r.Start() + 1, r.End() - 1, r.End(), r.Start() + uint64(rng.IntN(kept))} {
			got := r.From(off)
			assert.Assert(t, bytes.Equal(got, all[off:]), "after %d bytes: From(%d) is %d bytes, not the %d written from there", len(all), off, len(got), len(all)-int(off))
		}
	}
}

func TestRingKeepsTheTailOfAWriteLargerThanTheRing(t *testing.T) {
	r := newRing(16)
	r.Write([]byte("0123"))
	big := bytes.Repeat([]byte("abcdefgh"), 5)

	r.Write(big)

	assert.Check(t, cmp.Equal(r.Start(), uint64(28)))
	assert.Check(t, cmp.Equal(r.End(), uint64(44)))
	assert.Check(t, cmp.Equal(string(r.From(28)), string(big[24:])))
}

func TestRingStartsEmpty(t *testing.T) {
	r := newRing(16)

	assert.Check(t, cmp.Equal(r.Start(), uint64(0)))
	assert.Check(t, cmp.Equal(r.End(), uint64(0)))
	assert.Check(t, cmp.Len(r.From(0), 0))
}
