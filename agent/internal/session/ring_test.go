package session

import (
	"bytes"
	"math/rand/v2"
	"testing"
)

// The ring holds exactly the last ringSize bytes, wherever the writes split,
// and From reads any offset it holds.
func TestRingKeepsExactlyTheLastBytes(t *testing.T) {
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
		if cap(r.buf) > ringSize {
			t.Fatalf("after %d bytes: the ring holds %d bytes of memory, more than %d", len(all), cap(r.buf), ringSize)
		}
		if r.End() != uint64(len(all)) || r.Start() != uint64(len(all)-kept) {
			t.Fatalf("after %d bytes: start %d end %d, want %d %d", len(all), r.Start(), r.End(), len(all)-kept, len(all))
		}
		for _, off := range []uint64{r.Start(), r.Start() + 1, r.End() - 1, r.End(), r.Start() + uint64(rng.IntN(kept))} {
			if got := r.From(off); !bytes.Equal(got, all[off:]) {
				t.Fatalf("after %d bytes: From(%d) is %d bytes, not the %d written from there", len(all), off, len(got), len(all)-int(off))
			}
		}
	}
}

func TestRingWriteLargerThanTheRing(t *testing.T) {
	r := newRing(16)
	r.Write([]byte("0123"))
	big := bytes.Repeat([]byte("abcdefgh"), 5)
	r.Write(big)
	if r.Start() != 28 || r.End() != 44 {
		t.Fatalf("start %d end %d, want 28 44", r.Start(), r.End())
	}
	if got := string(r.From(28)); got != string(big[24:]) {
		t.Fatalf("From(28) = %q", got)
	}
}

func TestRingEmpty(t *testing.T) {
	r := newRing(16)
	if r.Start() != 0 || r.End() != 0 || len(r.From(0)) != 0 {
		t.Fatalf("empty ring: start %d end %d", r.Start(), r.End())
	}
}
