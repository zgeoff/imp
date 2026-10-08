package server

import (
	"io"
	"log"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// quietLog discards the recovered panics' stacks for the test.
func quietLog(t *testing.T) {
	t.Helper()
	prev := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(prev) })
}

// A Server with no Services dereferences nil. The agent is PID 1, so a panic
// in a unary request must cost one request, not the process.
func TestHandleRepliesInternalToAUnaryRequestThatPanics(t *testing.T) {
	quietLog(t)

	resp := roundTrip(t, &Server{}, proto.Request{Op: proto.OpServicesList})

	assert.Equal(t, errorCode(t, resp), proto.ErrInternal)
}

// A Server with no Exec dereferences nil outside safeUnary: the connection
// just closes.
func TestHandleClosesTheConnectionOfAStreamRequestThatPanics(t *testing.T) {
	quietLog(t)

	resp := roundTrip(t, &Server{}, proto.Request{Op: proto.OpExec, Argv: []string{"true"}})

	assert.Check(t, cmp.Nil(resp), "exec reply %s, want a closed connection", resp)
}
