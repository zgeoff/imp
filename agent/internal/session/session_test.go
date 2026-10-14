package session

import (
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// Once a viewer got the EXIT, nothing is left to attach to, and the refused
// viewer gets no frame.
func TestAttachRefusesASessionWhoseExitAViewerGot(t *testing.T) {
	s := newSession("job", &proto.Request{}, run{})
	s.markDelivered()
	v := newViewer(nil, nil)

	err := s.attach(v, 80, 24, false, nil, nil)

	assert.Check(t, cmp.ErrorIs(err, errOver))
	assert.Check(t, cmp.Len(v.queue, 0))
}
