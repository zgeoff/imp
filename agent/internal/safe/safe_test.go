package safe

import (
	"bytes"
	"io"
	"log"
	"os"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestMain(m *testing.M) {
	// The recovered panics log full stacks; keep test output readable.
	log.SetOutput(io.Discard)
	os.Exit(m.Run())
}

func TestGoRunsTheCleanupAfterAPanic(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var cleaned atomic.Bool

		Go("test", func() { panic("boom") }, func() { cleaned.Store(true) })
		synctest.Wait()

		assert.Assert(t, cleaned.Load(), "onPanic did not run")
	})
}

func TestGoSkipsTheCleanupWithoutAPanic(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var ran, cleaned atomic.Bool

		Go("test", func() { ran.Store(true) }, func() { cleaned.Store(true) })
		synctest.Wait()

		assert.Check(t, ran.Load(), "f did not run")
		assert.Check(t, !cleaned.Load(), "onPanic ran without a panic")
	})
}

func TestGoRecoversAPanicInTheCleanup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var cleaned atomic.Bool

		Go("test", func() { panic("boom") }, func() { cleaned.Store(true); panic("again") })
		synctest.Wait()

		assert.Assert(t, cleaned.Load(), "onPanic did not run")
	})
}

func TestCallRecoversAPanicAndReturns(t *testing.T) {
	// A panic that escaped Call would fail this test before it returned.
	Call("test", func() { panic("boom") })
}

func TestRecoverLogsThePanicUnderTheGivenName(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(io.Discard) })

	Call("worker", func() { panic("boom") })

	assert.Check(t, cmp.Contains(buf.String(), "worker: panic: boom"))
}
