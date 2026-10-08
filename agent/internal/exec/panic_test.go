package exec

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// startedPanics is a guest connection whose write of the STARTED frame
// panics, standing in for a bug in Serve itself. It waits for the child to
// write its pid first, so the test knows which process to watch.
type startedPanics struct {
	net.Conn
	pidFile string
}

func (c startedPanics) Write(b []byte) (int, error) {
	if len(b) > 0 && proto.Type(b[0]) == proto.TypeStarted {
		for range 250 {
			if b, err := os.ReadFile(c.pidFile); err == nil && len(b) > 0 {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		panic("serve bug")
	}
	return c.Conn.Write(b)
}

// A panic in Serve's own body hangs up the process before the panic travels
// on to the request handler.
func TestServeHangsUpTheProcessWhenItsOwnBodyPanics(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	guest, conn := net.Pipe()
	t.Cleanup(func() { conn.Close() })
	panicked := make(chan any, 1)
	go func() {
		defer func() { panicked <- recover() }()
		newManager().Serve(proto.Request{Op: proto.OpExec, Argv: []string{"sh", "-c", "echo $$ > " + pidFile + "; exec sleep 30"}},
			proto.NewReader(guest), proto.NewWriter(startedPanics{guest, pidFile}))
	}()
	pid := readPid(t, pidFile)
	t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })

	var v any
	select {
	case v = <-panicked:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve neither returned nor panicked")
	}

	assert.Check(t, v != nil, "Serve did not re-panic")
	// The reaper reaps it, so a dead child stops existing.
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if syscall.Kill(pid, 0) == nil {
			return poll.Continue("pid %d survives the panic", pid)
		}
		return poll.Success()
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(20*time.Millisecond))
}

// stdoutPanics is a guest connection whose writes of STDOUT frames panic,
// standing in for a bug in an output pump.
type stdoutPanics struct{ net.Conn }

func (c stdoutPanics) Write(b []byte) (int, error) {
	if len(b) > 0 && proto.Type(b[0]) == proto.TypeStdout {
		panic("pump bug")
	}
	return c.Conn.Write(b)
}

// A panic in a session goroutine ends that session (the process gets SIGHUP)
// instead of the agent.
func TestServeHangsUpTheProcessWhenASessionGoroutinePanics(t *testing.T) {
	prev := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(prev) })

	guest, conn := net.Pipe()
	t.Cleanup(func() { conn.Close() })
	served := make(chan error, 1)
	go func() {
		served <- newManager().Serve(proto.Request{Op: proto.OpExec, Argv: []string{"sh", "-c", "echo hi; exec sleep 30"}},
			proto.NewReader(guest), proto.NewWriter(stdoutPanics{guest}))
		guest.Close()
	}()

	assert.NilError(t, conn.SetDeadline(time.Now().Add(10*time.Second)))
	r := proto.NewReader(conn)
	var exit proto.Exit
	for {
		f, err := r.Next()
		assert.NilError(t, err, "no EXIT")
		if f.Type == proto.TypeExit {
			assert.NilError(t, json.Unmarshal(f.Payload, &exit))
			break
		}
	}
	conn.Close()
	err := <-served

	assert.Check(t, cmp.Equal(exit.Signal, int(syscall.SIGHUP)))
	assert.Check(t, err, "Serve")
}
