package inner

import (
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/reaper"
)

func TestWaitReadyRefusesAnInitThatSpeaksBeforeItIsReady(t *testing.T) {
	sp := socketpair(t)
	assert.NilError(t, send(sp[1], message{Op: opExit, Pid: 7}, nil))

	err := newClient(sp[0]).waitReady()

	assert.Error(t, err, `the inner init said "exit" before it was ready`)
}

// fakeInitProc is an init that never answers on its socket and dies when
// the test or a kill says so. kills counts the kills sent.
func fakeInitProc(t *testing.T) (p *initProc, died chan reaper.Status, kills chan struct{}) {
	t.Helper()
	sp, err := newSocketpair()
	assert.NilError(t, err)
	// connect closes the agent's end itself; the peer's is the test's
	t.Cleanup(func() { syscall.Close(sp[1]) })
	died = make(chan reaper.Status, 1)
	kills = make(chan struct{}, 1)
	p = newInitProc(1<<22, sp[0], died, func() error {
		kills <- struct{}{}
		died <- reaper.Status{Code: -1, Signal: syscall.SIGKILL}
		return nil
	}, func() {})
	return p, died, kills
}

func TestConnectFailsWhenTheInitDiesBeforeItIsReady(t *testing.T) {
	p, died, _ := fakeInitProc(t)
	died <- reaper.Status{Code: 2}

	_, err := connect(p)

	assert.Error(t, err, "the inner init exited before it was ready: exit 2")
}

func TestConnectKillsAnInitThatIsNotReadyInTime(t *testing.T) {
	old := readyTimeout
	readyTimeout = 50 * time.Millisecond
	t.Cleanup(func() { readyTimeout = old })
	p, _, kills := fakeInitProc(t)

	_, err := connect(p)

	assert.Check(t, cmp.Error(err, "the inner init was not ready after 50ms"))
	assert.Check(t, cmp.Len(kills, 1), "the init was not killed")
}
