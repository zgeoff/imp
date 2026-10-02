package boot

import (
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/zgeoff/imp/agent/internal/cmdline"
	"github.com/zgeoff/imp/agent/internal/inner"
)

const (
	// noMemoryLimit is memory.max's "max"
	noMemoryLimit = math.MaxInt64

	// memoryFollowInterval is how often an elastic guest checks its memory
	// size: a plug of 256 MiB comes in well under a second
	memoryFollowInterval = 250 * time.Millisecond
)

// userMemoryMax is the inner container's memory.max for a guest of total
// bytes: all but userReserve, or no limit in a guest too small to spare it.
func userMemoryMax(total int64) int64 {
	if total <= 2*userReserve {
		return noMemoryLimit
	}
	return total - userReserve
}

func writeUserMemoryMax(limit int64) {
	value := "max"
	if limit != noMemoryLimit {
		value = strconv.FormatInt(limit, 10)
	}
	if err := os.WriteFile(inner.CgroupDir+"/memory.max", []byte(value), 0); err != nil {
		log.Printf("boot: memory.max: %v", err)
	}
}

// userMemoryCurrent is what the inner container holds now, in bytes.
func userMemoryCurrent() (int64, error) {
	b, err := os.ReadFile(inner.CgroupDir + "/memory.current")
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
}

// memoryFollower is the loop that moves the container's limit with an
// elastic guest's memory (docs/architecture/memory.md#how-the-guest-grows);
// nil for a guest whose memory never changes, which keeps its boot limit.
func memoryFollower(p cmdline.Params) func() {
	if !p.HotplugMemory {
		return nil
	}
	return func() {
		ticker := time.NewTicker(memoryFollowInterval)
		followMemTotal(ticker.C, memTotal, userMemoryCurrent, writeUserMemoryMax)
	}
}

// followMemTotal checks the guest's memory on every tick and writes the
// container's limit only when it moves.
func followMemTotal(
	ticks <-chan time.Time,
	total func() int64,
	current func() (int64, error),
	write func(int64),
) {
	last := userMemoryMax(total())
	for range ticks {
		if next := nextUserMemoryMax(last, userMemoryMax(total()), current); next != last {
			write(next)
			last = next
		}
	}
}

// nextUserMemoryMax moves the limit toward target. A raise goes at once. A
// cut never goes below the container's use plus userReserve, so it never
// makes the kernel kill a user process to fit; later ticks go on down as the
// use falls. An unplug offlines memory only once the guest moved its pages
// away, so the use fits by then, but a cut does not rely on it.
func nextUserMemoryMax(last, target int64, current func() (int64, error)) int64 {
	if target >= last {
		return target
	}
	used, err := current()
	if err != nil {
		return last
	}
	return min(last, max(target, used+userReserve))
}
