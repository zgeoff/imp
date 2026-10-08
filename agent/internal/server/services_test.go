package server

import (
	"testing"

	"gotest.tools/v3/assert"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/services"
)

// The services ops reach the supervisor; names it does not have come back
// as NO_SERVICE, and an add with no definition as BAD_REQUEST.
func TestServicesOpsReplyWithTheSupervisorsErrorCode(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  proto.Request
		code string
	}{
		{name: "add without a definition", req: proto.Request{Op: proto.OpServicesAdd}, code: proto.ErrBadRequest},
		{name: "remove of no service", req: proto.Request{Op: proto.OpServicesRemove, Service: "imp-test-none"}, code: proto.ErrNoService},
		{name: "restart of no service", req: proto.Request{Op: proto.OpServicesRestart, Service: "imp-test-none"}, code: proto.ErrNoService},
		{name: "logs of no service", req: proto.Request{Op: proto.OpServicesLogs, Service: "imp-test-none", Lines: 10}, code: proto.ErrNoService},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{Services: services.New(&proc.Direct{Reaper: testReaper}, fsroot.Host, imagecfg.NewLive(imagecfg.Config{}))}

			resp := roundTrip(t, s, tc.req)

			assert.Equal(t, errorCode(t, resp), tc.code)
		})
	}
}
