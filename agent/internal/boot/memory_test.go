package boot

import (
	"errors"
	"math"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/zgeoff/imp/agent/internal/cmdline"
)

const mib = 1 << 20

func TestUserMemoryMaxLeavesTheReserveOrNoLimitInASmallGuest(t *testing.T) {
	for _, tc := range []struct {
		name  string
		total int64
		want  int64
	}{
		{name: "256 MiB keeps 64 MiB back", total: 256 * mib, want: 192 * mib},
		{name: "128 MiB has no limit", total: 128 * mib, want: math.MaxInt64},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, userMemoryMax(tc.total), tc.want)
		})
	}
}

// A plain imp's memory never changes: no follower runs, and its container
// keeps the limit it got at boot.
func TestMemoryFollowerRunsOnlyForHotplugMemory(t *testing.T) {
	for _, tc := range []struct {
		name   string
		params cmdline.Params
		want   bool
	}{
		{name: "plain guest", params: cmdline.Params{}, want: false},
		{name: "elastic guest", params: cmdline.Params{HotplugMemory: true}, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, memoryFollower(tc.params) != nil, tc.want)
		})
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
func TestFollowMemTotalWritesTheLimitOnlyWhenTheSizeChanges(t *testing.T) {
	written := runFollower([]int64{256 * mib, 512 * mib, 512 * mib, 384 * mib}, []int64{100 * mib})

	assert.DeepEqual(t, written, []int64{448 * mib, 320 * mib})
}

// After an unplug, the container still holds more than the new limit would
// leave it: the cut stops at its use plus the reserve, and goes on down as
// the use falls.
func TestFollowMemTotalStopsACutAboveTheContainersUse(t *testing.T) {
	written := runFollower([]int64{512 * mib, 256 * mib, 256 * mib, 256 * mib}, []int64{300 * mib, 250 * mib, 100 * mib})

	assert.DeepEqual(t, written, []int64{364 * mib, 314 * mib, 192 * mib})
}

// With the container's use unknown, a cut waits; a raise does not.
func TestFollowMemTotalHoldsACutWhileTheUseIsUnknown(t *testing.T) {
	written := runFollower([]int64{512 * mib, 256 * mib, 768 * mib}, nil)

	assert.DeepEqual(t, written, []int64{704 * mib})
}
