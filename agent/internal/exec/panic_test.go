package exec

import (
	"encoding/json"
	"io"
	"log"
	"net"
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
// panics once release closes, standing in for a bug in Serve itself. The
// test closes release once the child has written its pid, so it knows which
// process to watch. It counts on proto.Writer sending each frame in one
// Write that starts with the frame's type.
type startedPanics struct {
	net.Conn
	release <-chan struct{}
}

func (c startedPanics) Write(b []byte) (int, error) {
	if len(b) > 0 && proto.Type(b[0]) == proto.TypeStarted {
		<-c.release
		panic("serve bug")
	}
	return c.Conn.Write(b)
}

// stdoutPanics is a guest connection whose writes of STDOUT frames panic,
// standing in for a bug in an output pump. It counts on proto.Writer as
// startedPanics does.
type stdoutPanics struct{ net.Conn }

func (c stdoutPanics) Write(b []byte) (int, error) {
	if len(b) > 0 && proto.Type(b[0]) == proto.TypeStdout {
		panic("pump bug")
	}
	return c.Conn.Write(b)
}

func TestTheStandInConnectionsPanicOnTheirFrameFromAProtoWriter(t *testing.T) {
	released := make(chan struct{})
	close(released)
	for _, tc := range []struct {
		name string
		conn net.Conn
		typ  proto.Type
		want string
	}{
		{name: "started", conn: startedPanics{release: released}, typ: proto.TypeStarted, want: "serve bug"},
		{name: "stdout", conn: stdoutPanics{}, typ: proto.TypeStdout, want: "pump bug"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := proto.NewWriter(tc.conn)
			var panicked any

			func() {
				defer func() { panicked = recover() }()
				w.Write(tc.typ, []byte(`{"pid":1}`))
			}()

			assert.Check(t, cmp.Equal(panicked, tc.want))
		})
	}
}

func TestTheStandInConnectionsPassOtherFramesThrough(t *testing.T) {
	for _, tc := range []struct {
		name string
		conn func(net.Conn) net.Conn
		typ  proto.Type
	}{
		{name: "started", conn: func(c net.Conn) net.Conn { return startedPanics{Conn: c, release: make(chan struct{})} }, typ: proto.TypeStdout},
		{name: "stdout", conn: func(c net.Conn) net.Conn { return stdoutPanics{c} }, typ: proto.TypeStderr},
	} {
		t.Run(tc.name, func(t *testing.T) {
			guest, conn := net.Pipe()
			t.Cleanup(func() { guest.Close(); conn.Close() })
			read := make(chan proto.Frame, 1)
			go func() {
				defer close(read)
				if f, err := proto.NewReader(conn).Next(); err == nil {
					read <- f
				}
			}()

			err := proto.NewWriter(tc.conn(guest)).Write(tc.typ, []byte("hi"))

			assert.NilError(t, err)
			select {
			case f := <-read:
				assert.Check(t, cmp.DeepEqual(f, proto.Frame{Type: tc.typ, Payload: []byte("hi")}))
			case <-time.After(5 * time.Second):
				t.Fatal("the frame never reached the host")
			}
		})
	}
}

// A panic in Serve's own body hangs up the process before the panic travels
// on to the request handler.
func TestServeHangsUpTheProcessWhenItsOwnBodyPanics(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	guest, conn := net.Pipe()
	t.Cleanup(func() { conn.Close() })
	release := make(chan struct{})
	panicked := make(chan any, 1)
	go func() {
		defer func() { panicked <- recover() }()
		newManager().Serve(&proto.Request{Op: proto.OpExec, Argv: []string{"sh", "-c", "echo $$ > " + pidFile + "; exec sleep 30"}},
			proto.NewReader(guest), proto.NewWriter(startedPanics{guest, release}))
	}()
	pid := readPid(t, pidFile)
	t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
	close(release)

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
		served <- newManager().Serve(&proto.Request{Op: proto.OpExec, Argv: []string{"sh", "-c", "echo hi; exec sleep 30"}},
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

	assert.Check(t, cmp.Equal(exit.Signal, int32(syscall.SIGHUP)))
	assert.Check(t, err, "Serve")
}
