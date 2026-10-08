package inner

import (
	"strings"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
)

// socketpair makes the SEQPACKET pair and closes both ends after the test.
func socketpair(t *testing.T) [2]int {
	t.Helper()
	sp, err := newSocketpair()
	assert.NilError(t, err)
	t.Cleanup(func() {
		unix.Close(sp[0])
		unix.Close(sp[1])
	})
	return sp
}

func TestRecvReportsAPeerThatShutTheSocketAsClosed(t *testing.T) {
	sp := socketpair(t)
	assert.NilError(t, unix.Shutdown(sp[1], unix.SHUT_RDWR))

	_, _, err := recv(sp[0], make([]byte, 4096))

	assert.ErrorIs(t, err, errClosed)
}

// The error carries no sentinel; its text is its only identity.
func TestRecvRefusesAMessageLongerThanItsBuffer(t *testing.T) {
	sp := socketpair(t)
	assert.NilError(t, send(sp[1], message{Op: opSpawn, Spec: &wireSpec{Argv: []string{"a long enough argv"}}}, nil))

	_, _, err := recv(sp[0], make([]byte, 8))

	assert.Error(t, err, "a message was cut short")
}

func TestSendRefusesAMessagePastTheLimit(t *testing.T) {
	sp := socketpair(t)

	err := send(sp[1], message{Op: opSpawn, Spec: &wireSpec{Argv: []string{strings.Repeat("x", maxMessage)}}}, nil)

	assert.ErrorContains(t, err, "bytes passes the 4194304-byte limit")
}
