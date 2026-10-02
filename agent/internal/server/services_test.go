package server

import (
	"encoding/json"
	"testing"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/services"
)

// The services ops reach the supervisor; names it does not have come back
// as NO_SERVICE, and an add with no definition as BAD_REQUEST.
func TestServicesOpsReply(t *testing.T) {
	s := &Server{Services: services.New(&proc.Direct{Reaper: reaper.New()}, fsroot.Host, imagecfg.Config{})}
	tests := []struct {
		req  proto.Request
		code string
	}{
		{proto.Request{Op: proto.OpServicesAdd}, proto.ErrBadRequest},
		{proto.Request{Op: proto.OpServicesRemove, Service: "imp-test-none"}, proto.ErrNoService},
		{proto.Request{Op: proto.OpServicesRestart, Service: "imp-test-none"}, proto.ErrNoService},
		{proto.Request{Op: proto.OpServicesLogs, Service: "imp-test-none", Lines: 10}, proto.ErrNoService},
	}
	for _, tt := range tests {
		resp := roundTrip(t, s, tt.req)
		var er proto.ErrorResponse
		if err := json.Unmarshal(resp, &er); err != nil || er.Error == nil || er.Error.Code != tt.code {
			t.Errorf("%s reply = %s, want %s", tt.req.Op, resp, tt.code)
		}
	}
}
