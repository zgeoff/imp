package server

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// TestHandleRecoversPanic sends requests that panic: a Server with no
// Services and no Exec dereferences nil. The agent is PID 1, so a panic must
// cost one request, not the process.
func TestHandleRecoversPanic(t *testing.T) {
	prev := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(prev) })
	s := &Server{}

	resp := roundTrip(t, s, proto.Request{Op: proto.OpServicesList})
	var er proto.ErrorResponse
	if err := json.Unmarshal(resp, &er); err != nil || er.Error == nil || er.Error.Code != proto.ErrInternal {
		t.Fatalf("services_list reply = %s, want INTERNAL", resp)
	}

	// exec panics outside safeUnary; the connection just closes.
	if resp := roundTrip(t, s, proto.Request{Op: proto.OpExec, Argv: []string{"true"}}); resp != nil {
		t.Fatalf("exec reply = %s, want a closed connection", resp)
	}
}

// roundTrip runs one request through handle and returns the RESPONSE
// payload, or nil if the connection closed without one.
func roundTrip(t *testing.T, s *Server, req proto.Request) []byte {
	t.Helper()
	host, guest := net.Pipe()
	defer host.Close()
	done := make(chan struct{})
	go func() { s.handle(guest); close(done) }()

	host.SetDeadline(time.Now().Add(5 * time.Second))
	if err := proto.NewWriter(host).WriteJSON(proto.TypeRequest, req); err != nil {
		t.Fatal(err)
	}
	f, err := proto.NewReader(host).Next()
	<-done
	if err != nil {
		return nil
	}
	return f.Payload
}
