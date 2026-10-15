package server

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"

	"github.com/zgeoff/impz/agent/internal/proto"
)

// A failed clock read leaves uptime_ms out instead of reporting 0, which
// impd would read as a young guest.
func TestPingOmitsUptimeWithoutAClock(t *testing.T) {
	failing := func(int32, *unix.Timespec) error { return errors.New("no clock") }

	data, err := proto.Marshal(BuildPing(failing))

	assert.NilError(t, err)
	assert.Check(t, !strings.Contains(string(data), "uptime_ms"), "ping = %s, want no uptime_ms", data)
}

func TestPingReportsUptimeFromTheClock(t *testing.T) {
	clock := func(_ int32, ts *unix.Timespec) error {
		*ts = unix.NsecToTimespec(2_500_000_000)
		return nil
	}

	ping := BuildPing(clock)

	assert.Assert(t, ping.UptimeMs != nil)
	assert.Equal(t, *ping.UptimeMs, 2500.0)
}

func TestPingOmitsTheIdentityResetWhenNoneRan(t *testing.T) {
	s := &Server{}

	resp, err := s.unary(&proto.Request{Op: proto.OpPing})

	assert.NilError(t, err)
	data, err := proto.Marshal(resp)
	assert.NilError(t, err)
	assert.Check(t, !strings.Contains(string(data), "identity_reset"), "ping = %s", data)
}

// impd clears an imp's pending identity reset only on an ok in the ping.
func TestPingReportsTheIdentityResetThatRan(t *testing.T) {
	for _, reset := range []string{proto.IdentityResetOK, proto.IdentityResetFailed} {
		t.Run(reset, func(t *testing.T) {
			s := &Server{IdentityReset: reset}

			resp, err := s.unary(&proto.Request{Op: proto.OpPing})

			assert.NilError(t, err)
			assert.Equal(t, resp.(*proto.Ping).GetIdentityReset(), reset)
		})
	}
}

// impd records a cold boot under the boot_id the ping reports.
func TestPingReportsTheBootID(t *testing.T) {
	s := &Server{BootID: "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11"}

	resp, err := s.unary(&proto.Request{Op: proto.OpPing})

	assert.NilError(t, err)
	assert.Equal(t, resp.(*proto.Ping).GetBootId(), "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
}
