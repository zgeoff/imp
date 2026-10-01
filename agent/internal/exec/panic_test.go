package exec

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

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

// TestServePanicEndsSession checks that a panic in Serve's own body hangs
// up the process before the panic travels on to the request handler.
func TestServePanicEndsSession(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	guest, conn := net.Pipe()
	defer conn.Close()
	panicked := make(chan any, 1)
	go func() {
		defer func() { panicked <- recover() }()
		newManager().Serve(proto.Request{Op: proto.OpExec, Argv: []string{"sh", "-c", "echo $$ > " + pidFile + "; exec sleep 30"}},
			proto.NewReader(guest), proto.NewWriter(startedPanics{guest, pidFile}))
	}()
	select {
	case v := <-panicked:
		if v == nil {
			t.Fatal("Serve did not re-panic")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve neither returned nor panicked")
	}
	b, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	// The reaper reaps it, so a dead child stops existing.
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("pid %d survived the panic", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
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

// TestSessionPanicEndsSession checks that a panic in a session goroutine
// ends that session (the process gets SIGHUP) instead of the agent.
func TestSessionPanicEndsSession(t *testing.T) {
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

	conn.SetDeadline(time.Now().Add(10 * time.Second))
	r := proto.NewReader(conn)
	var exit proto.Exit
	for {
		f, err := r.Next()
		if err != nil {
			t.Fatalf("no EXIT: %v", err)
		}
		if f.Type == proto.TypeExit {
			if err := json.Unmarshal(f.Payload, &exit); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if exit.Signal != int(syscall.SIGHUP) {
		t.Fatalf("exit = %+v, want SIGHUP", exit)
	}
	conn.Close()
	if err := <-served; err != nil {
		t.Fatalf("Serve = %v", err)
	}
}
