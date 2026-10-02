package server

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// TestPingOmitsUptimeWithoutAClock checks that a failed clock read leaves
// uptime_ms out instead of reporting 0, which impd would read as a young guest.
func TestPingOmitsUptimeWithoutAClock(t *testing.T) {
	failing := func(int32, *unix.Timespec) error { return errors.New("no clock") }
	data, err := json.Marshal(buildPing(failing))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "uptime_ms") {
		t.Fatalf("ping = %s, want no uptime_ms", data)
	}
}

func TestPingReportsUptime(t *testing.T) {
	clock := func(_ int32, ts *unix.Timespec) error {
		*ts = unix.NsecToTimespec(2_500_000_000)
		return nil
	}
	ping := buildPing(clock)
	if ping.UptimeMs == nil || *ping.UptimeMs != 2500 {
		t.Fatalf("UptimeMs = %v, want 2500", ping.UptimeMs)
	}
}
