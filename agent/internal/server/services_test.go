package server

import (
	"testing"

	"gotest.tools/v3/assert"

	"github.com/zgeoff/impz/agent/internal/fsroot"
	"github.com/zgeoff/impz/agent/internal/imagecfg"
	"github.com/zgeoff/impz/agent/internal/proc"
	"github.com/zgeoff/impz/agent/internal/proto"
	"github.com/zgeoff/impz/agent/internal/services"
)

// The services ops reach the supervisor; names it does not have come back
// as NO_SERVICE, and an add with no definition as BAD_REQUEST.
func TestServicesOpsReplyWithTheSupervisorsErrorCode(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  *proto.Request
		code string
	}{
		{name: "add without a definition", req: &proto.Request{Op: proto.OpServicesAdd}, code: proto.ErrBadRequest},
		{name: "remove of no service", req: &proto.Request{Op: proto.OpServicesRemove, Service: new("imp-test-none")}, code: proto.ErrNoService},
		{name: "restart of no service", req: &proto.Request{Op: proto.OpServicesRestart, Service: new("imp-test-none")}, code: proto.ErrNoService},
		{name: "logs of no service", req: &proto.Request{Op: proto.OpServicesLogs, Service: new("imp-test-none"), Lines: new(uint32(10))}, code: proto.ErrNoService},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// the supervisor's paths resolve in a root of the test's own,
			// never in the host's /etc/imp/services.d
			root, err := fsroot.Open(t.TempDir())
			assert.NilError(t, err)
			t.Cleanup(func() { root.Close() })
			s := &Server{Services: services.New(&proc.Direct{Reaper: testReaper}, root, imagecfg.NewLive(imagecfg.Config{}))}

			resp := roundTrip(t, s, tc.req)

			assert.Equal(t, errorCode(t, resp), tc.code)
		})
	}
}
