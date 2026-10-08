package server

import (
	"encoding/json"
	"net"
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/session"
)

// request opens a connection to s, sends req and returns the first reply
// frame, with the connection for more.
func request(t *testing.T, s *Server, req proto.Request) (proto.Frame, net.Conn) {
	t.Helper()
	guest, conn := net.Pipe()
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		s.handle(guest)
	}()
	t.Cleanup(func() {
		conn.Close()
		select {
		case <-handled:
		case <-time.After(5 * time.Second):
			t.Error("handle did not return after the host closed")
		}
	})
	assert.NilError(t, conn.SetDeadline(time.Now().Add(5*time.Second)))
	assert.NilError(t, proto.NewWriter(conn).WriteJSON(proto.TypeRequest, req))
	f, err := proto.NewReader(conn).Next()
	assert.NilError(t, err)
	return f, conn
}

func newSessionServer(t *testing.T) *Server {
	t.Helper()
	l := launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil)
	return &Server{Exec: exec.NewManager(l, nil), Outer: exec.NewStrictManager(l, nil), Sessions: session.NewManager(l, "")}
}

// startSession runs an exec with a session name and returns its STARTED and
// connection; the session's process group dies with the test.
func startSession(t *testing.T, s *Server, name string) (proto.Started, net.Conn) {
	t.Helper()
	f, conn := request(t, s, proto.Request{Op: proto.OpExec, Session: name, TTY: true, Argv: []string{"sleep", "30"}})
	assert.Assert(t, cmp.Equal(f.Type, proto.TypeStarted), "%q", f.Payload)
	var st proto.Started
	assert.NilError(t, json.Unmarshal(f.Payload, &st))
	t.Cleanup(func() { syscall.Kill(-st.Pid, syscall.SIGKILL) })
	return st, conn
}

func TestSessionKillOfNoSessionIsNoSession(t *testing.T) {
	s := newSessionServer(t)

	f, _ := request(t, s, proto.Request{Op: proto.OpSessionKill, Session: "main"})

	assert.Equal(t, replyCode(t, f), proto.ErrNoSession)
}

// exec with a session name goes to the session manager.
func TestExecWithASessionNameStartsThatSession(t *testing.T) {
	s := newSessionServer(t)

	st, _ := startSession(t, s, "main")

	assert.Equal(t, st.Session, "main")
}

func TestActivityCountsAnAttachedSessionAsAnExec(t *testing.T) {
	s := newSessionServer(t)
	startSession(t, s, "main")

	act, err := s.activity()

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(act.ExecSessions, 1))
	assert.Assert(t, cmp.Len(act.Sessions, 1))
	assert.Check(t, cmp.Equal(act.Sessions[0].Name, "main"))
	assert.Check(t, act.Sessions[0].Attached)
}

func TestActivityListsADetachedSessionButCountsNoExec(t *testing.T) {
	s := newSessionServer(t)
	_, conn := startSession(t, s, "main")
	conn.Close()
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if n := s.Sessions.Attached(); n > 0 {
			return poll.Continue("%d attached", n)
		}
		return poll.Success()
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))

	act, err := s.activity()

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(act.ExecSessions, 0))
	assert.Assert(t, cmp.Len(act.Sessions, 1))
	assert.Check(t, !act.Sessions[0].Attached)
}

func TestSessionKillOfARunningSessionRepliesOK(t *testing.T) {
	s := newSessionServer(t)
	startSession(t, s, "main")

	f, _ := request(t, s, proto.Request{Op: proto.OpSessionKill, Session: "main"})

	assert.Check(t, cmp.Equal(f.Type, proto.TypeResponse))
	assert.Check(t, cmp.Equal(string(f.Payload), `{"ok":true}`))
}
