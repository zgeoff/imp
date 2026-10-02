package server

import (
	"encoding/json"
	"net"
	"syscall"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/session"
)

// request opens a connection to s, sends req and returns the first reply
// frame, with the connection for more.
func request(t *testing.T, s *Server, req proto.Request) (proto.Frame, net.Conn) {
	t.Helper()
	guest, conn := net.Pipe()
	go s.handle(guest)
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	if err := proto.NewWriter(conn).WriteJSON(proto.TypeRequest, req); err != nil {
		t.Fatal(err)
	}
	f, err := proto.NewReader(conn).Next()
	if err != nil {
		t.Fatal(err)
	}
	return f, conn
}

// TestSessionRequests checks the dispatch: exec with a session name goes to
// the session manager, and activity lists the sessions.
func TestSessionRequests(t *testing.T) {
	l := launch.New(reaper.New(), imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}})
	s := &Server{Exec: exec.NewManager(l, nil), Sessions: session.NewManager(l)}

	f, _ := request(t, s, proto.Request{Op: proto.OpSessionKill, Session: "main"})
	var resp proto.ErrorResponse
	if f.Type != proto.TypeResponse || json.Unmarshal(f.Payload, &resp) != nil || resp.Error == nil || resp.Error.Code != proto.ErrNoSession {
		t.Fatalf("kill of no session: %q, want NO_SESSION", f.Payload)
	}

	f, conn := request(t, s, proto.Request{Op: proto.OpExec, Session: "main", TTY: true, Argv: []string{"sleep", "30"}})
	var st proto.Started
	if f.Type != proto.TypeStarted || json.Unmarshal(f.Payload, &st) != nil || st.Session != "main" {
		t.Fatalf("exec: got %s %q, want STARTED for session main", f.Type, f.Payload)
	}
	defer syscall.Kill(-st.Pid, syscall.SIGKILL)

	act, err := s.activity()
	if err != nil {
		t.Fatal(err)
	}
	if act.ExecSessions != 1 || len(act.Sessions) != 1 || act.Sessions[0].Name != "main" || !act.Sessions[0].Attached {
		t.Fatalf("activity while attached: %+v", act)
	}

	conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	for s.Sessions.Attached() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if act, _ := s.activity(); act.ExecSessions != 0 || len(act.Sessions) != 1 || act.Sessions[0].Attached {
		t.Fatalf("activity after detach: %+v", act)
	}

	f, _ = request(t, s, proto.Request{Op: proto.OpSessionKill, Session: "main"})
	if f.Type != proto.TypeResponse || string(f.Payload) != `{"ok":true}` {
		t.Fatalf("kill: got %s %q", f.Type, f.Payload)
	}
}
