package boot

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/cmdline"
)

const mib = 1 << 20

func TestUserMemoryMax(t *testing.T) {
	if got := userMemoryMax(256 * mib); got != 192*mib {
		t.Fatalf("userMemoryMax(256 MiB) = %d, want 192 MiB", got)
	}
	if got := userMemoryMax(2 * userReserve); got != noMemoryLimit {
		t.Fatalf("userMemoryMax(2 × reserve) = %d, want no limit", got)
	}
}

// A plain imp's memory never changes: no follower runs, and its container
// keeps the limit it got at boot.
func TestMemoryFollowerOnlyForHotplugMemory(t *testing.T) {
	if memoryFollower(cmdline.Params{}) != nil {
		t.Fatal("a guest without hot-plug memory got a memory follower")
	}
	if memoryFollower(cmdline.Params{HotplugMemory: true}) == nil {
		t.Fatal("an elastic guest got no memory follower")
	}
}

// runFollower feeds followMemTotal one tick per size after the first and
// returns what it wrote; `used` is the container's use at each tick.
func runFollower(sizes []int64, used []int64) []int64 {
	tickCount := len(sizes) - 1
	ticks := make(chan time.Time)
	var written []int64
	done := make(chan struct{})
	total := func() int64 {
		size := sizes[0]
		sizes = sizes[1:]
		return size
	}
	current := func() (int64, error) {
		if len(used) == 0 {
			return 0, errors.New("no memory.current")
		}
		u := used[0]
		used = used[1:]
		return u, nil
	}
	go func() {
		followMemTotal(ticks, total, current, func(limit int64) { written = append(written, limit) })
		close(done)
	}()
	for range tickCount {
		ticks <- time.Time{}
	}
	close(ticks)
	<-done
	return written
}

// A plug, a tick with no change, then an unplug with little in use: the
// limit is written once for each change, never for a tick that saw none.
func TestFollowMemTotal(t *testing.T) {
	written := runFollower([]int64{256 * mib, 512 * mib, 512 * mib, 384 * mib}, []int64{100 * mib})
	if want := []int64{448 * mib, 320 * mib}; !reflect.DeepEqual(written, want) {
		t.Fatalf("written = %v, want %v", written, want)
	}
}

// After an unplug, the container still holds more than the new limit would
// leave it: the cut stops at its use plus the reserve, and goes on down as
// the use falls.
func TestFollowMemTotalCutStopsAboveUse(t *testing.T) {
	sizes := []int64{512 * mib, 256 * mib, 256 * mib, 256 * mib}
	written := runFollower(sizes, []int64{300 * mib, 250 * mib, 100 * mib})
	if want := []int64{364 * mib, 314 * mib, 192 * mib}; !reflect.DeepEqual(written, want) {
		t.Fatalf("written = %v, want %v", written, want)
	}
}

// With the container's use unknown, a cut waits; a raise does not.
func TestFollowMemTotalCutWaitsForUse(t *testing.T) {
	written := runFollower([]int64{512 * mib, 256 * mib, 768 * mib}, nil)
	if want := []int64{704 * mib}; !reflect.DeepEqual(written, want) {
		t.Fatalf("written = %v, want %v", written, want)
	}
}
