package safe

import (
	"io"
	"log"
	"os"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// The recovered panics log full stacks; keep test output readable.
	log.SetOutput(io.Discard)
	os.Exit(m.Run())
}

func TestGoRecoversAndCleansUp(t *testing.T) {
	cleaned := make(chan struct{})
	Go("test", func() { panic("boom") }, func() { close(cleaned) })
	wait(t, cleaned)
}

func TestGoWithoutPanicSkipsCleanup(t *testing.T) {
	done := make(chan struct{})
	Go("test", func() { close(done) }, func() { t.Error("onPanic ran without a panic") })
	<-done
}

func TestCleanupPanicIsRecovered(t *testing.T) {
	ran := make(chan struct{})
	Go("test", func() { panic("boom") }, func() { close(ran); panic("again") })
	wait(t, ran)
}

func TestCallRecovers(t *testing.T) {
	Call("test", func() { panic("boom") })
}

func wait(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(time.Second):
		t.Fatal("onPanic did not run")
	}
}
