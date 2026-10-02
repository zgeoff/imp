package server

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// TestPingOmitsUptimeWithoutAClock checks that a failed clock read leaves
// uptime_ms out instead of reporting 0, which impd would read as a young guest.
func TestPingOmitsUptimeWithoutAClock(t *testing.T) {
	failing := func(int32, *unix.Timespec) error { return errors.New("no clock") }
	data, err := json.Marshal(BuildPing(failing))
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
	ping := BuildPing(clock)
	if ping.UptimeMs == nil || *ping.UptimeMs != 2500 {
		t.Fatalf("UptimeMs = %v, want 2500", ping.UptimeMs)
	}
}

// impd clears an imp's pending identity reset only on an ok in the ping.
func TestPingReportsTheIdentityReset(t *testing.T) {
	for _, reset := range []string{"", proto.IdentityResetOK, proto.IdentityResetFailed} {
		s := &Server{IdentityReset: reset}
		resp, err := s.unary(proto.Request{Op: proto.OpPing})
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(resp)
		if err != nil {
			t.Fatal(err)
		}
		has := strings.Contains(string(data), `"identity_reset":"`+reset+`"`)
		if has != (reset != "") || (reset == "" && strings.Contains(string(data), "identity_reset")) {
			t.Fatalf("reset %q: ping = %s", reset, data)
		}
	}
}

// impd records a cold boot under the boot_id the ping reports.
func TestPingReportsTheBootID(t *testing.T) {
	s := &Server{BootID: "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11"}
	resp, err := s.unary(proto.Request{Op: proto.OpPing})
	if err != nil {
		t.Fatal(err)
	}
	if ping := resp.(proto.Ping); ping.BootID != s.BootID {
		t.Fatalf("ping %+v, want boot_id %s", ping, s.BootID)
	}
}
