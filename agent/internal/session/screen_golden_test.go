package session

import (
	"crypto/sha256"
	"encoding/hex"
	"math/rand/v2"
	"strconv"
	"strings"
	"testing"
)

// goldenOutput is a program's output, the same on every run: text, colours,
// UTF-8, OSC titles, the modes a replay restores and kitty flags, written in
// chunks of uneven size. It runs past historyLimit, so the history drops
// part of it and cuts at a ground state.
func goldenOutput() [][]byte {
	rng := rand.New(rand.NewPCG(97, 2026))
	units := []func() string{
		func() string { return strings.Repeat("abcdefghij", 1+rng.IntN(12)) + "\r\n" },
		func() string { return "\x1b[38;5;" + strconv.Itoa(rng.IntN(256)) + "m" },
		func() string { return "\x1b[0m" },
		func() string { return "é€ü漢字🙂" },
		func() string { return "\x1b]0;title " + strconv.Itoa(rng.IntN(1000)) + "\x07" },
		func() string { return "\x1b]2;" + strings.Repeat("t", rng.IntN(300)) + "\x1b\\" },
		func() string { return []string{"\x1b[?1049h", "\x1b[?1049l"}[rng.IntN(2)] },
		func() string { return []string{"\x1b[?2004h", "\x1b[?2004l"}[rng.IntN(2)] },
		func() string { return []string{"\x1b[?1000h", "\x1b[?1006h", "\x1b[?1000l"}[rng.IntN(3)] },
		func() string { return []string{"\x1b[?25l", "\x1b[?25h", "\x1b[?1h"}[rng.IntN(3)] },
		func() string { return []string{"\x1b[>1u", "\x1b[<u", "\x1b[=3;1u"}[rng.IntN(3)] },
	}
	var all strings.Builder
	for all.Len() < 800<<10 {
		all.WriteString(units[rng.IntN(len(units))]())
	}
	out := []byte(all.String())
	var chunks [][]byte
	for len(out) > 0 {
		n := min(len(out), 1+rng.IntN(40000))
		chunks = append(chunks, out[:n])
		out = out[n:]
	}
	return chunks
}

// The replay a fresh attach gets, pinned to what the history gave before
// output offsets: offsets must not change a byte of it.
const (
	goldenReplayBytes  = 274484
	goldenReplaySHA256 = "1fbcb94098ee4593c6e2de11aad8c55bf2a15ae11f496e9b98402b3798318bc3"
)

func TestHistoryReplayMatchesTheGolden(t *testing.T) {
	h := newHistory(historyLimit)
	for _, chunk := range goldenOutput() {
		h.Write(chunk)
	}
	got := replay(h)
	sum := sha256.Sum256(got)
	if len(got) != goldenReplayBytes || hex.EncodeToString(sum[:]) != goldenReplaySHA256 {
		t.Fatalf("replay is %d bytes, sha256 %x; the golden is %d bytes, %s", len(got), sum, goldenReplayBytes, goldenReplaySHA256)
	}
}
