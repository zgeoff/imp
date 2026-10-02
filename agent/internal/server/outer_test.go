package server

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zgeoff/imp/agent/internal/cgroup"
	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"github.com/zgeoff/imp/agent/internal/session"
)

// downRunner is an inner container that is down.
type downRunner struct{}

func (downRunner) Start(proc.Spec) (*proc.Process, error) { return nil, proc.ErrDown }

// outsideRunner runs in this process's world. A test's leaves are plain
// directories, so it drops the cgroup after it records that one was given.
type outsideRunner struct {
	direct   *proc.Direct
	inCgroup chan bool
}

func (r outsideRunner) Start(s proc.Spec) (*proc.Process, error) {
	r.inCgroup <- s.Cgroup != nil
	s.Cgroup = nil
	return r.direct.Start(s)
}

func newOuterServer(t *testing.T) (*Server, chan bool) {
	t.Helper()
	tree, err := cgroup.NewTree(filepath.Join(t.TempDir(), "outer"))
	if err != nil {
		t.Fatal(err)
	}
	image := imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}})
	inner := launch.New(downRunner{}, image, nil)
	inCgroup := make(chan bool, 1)
	outside := launch.New(outsideRunner{direct: &proc.Direct{Reaper: reaper.New()}, inCgroup: inCgroup}, image, nil)
	return &Server{
		Exec:     exec.NewManager(inner, nil),
		Outer:    exec.NewStrictManager(outside, tree),
		Sessions: session.NewManager(inner, ""),
	}, inCgroup
}

// TestOuterExecRunsWithTheContainerDown: exec.outer goes to the outer
// manager, in a leaf of its cgroup, while a plain exec finds the container
// down.
func TestOuterExecRunsWithTheContainerDown(t *testing.T) {
	s, inCgroup := newOuterServer(t)

	f, _ := request(t, s, proto.Request{Op: proto.OpExec, Argv: []string{"echo", "hi"}})
	var resp proto.ErrorResponse
	if json.Unmarshal(f.Payload, &resp) != nil || resp.Error == nil || resp.Error.Code != proto.ErrInnerDown {
		t.Fatalf("plain exec: %s %q, want INNER_DOWN", f.Type, f.Payload)
	}

	for _, tty := range []bool{false, true} {
		f, conn := request(t, s, proto.Request{Op: proto.OpExecOuter, Argv: []string{"echo", "outside"}, TTY: tty})
		if f.Type != proto.TypeStarted {
			t.Fatalf("tty %v: got %s %q, want STARTED", tty, f.Type, f.Payload)
		}
		if !<-inCgroup {
			t.Fatalf("tty %v: the outer exec started without a cgroup leaf", tty)
		}
		r := proto.NewReader(conn)
		var out strings.Builder
		for {
			f, err := r.Next()
			if err != nil {
				t.Fatal(err)
			}
			if f.Type == proto.TypeStdout {
				out.Write(f.Payload)
			}
			if f.Type == proto.TypeExit {
				break
			}
		}
		if !strings.Contains(out.String(), "outside") {
			t.Fatalf("tty %v: output %q", tty, out.String())
		}
	}
}

func TestOuterExecRefuses(t *testing.T) {
	s, _ := newOuterServer(t)
	for _, req := range []proto.Request{
		{Op: proto.OpExecOuter, Argv: []string{"sh"}, TTY: true, Session: "main"},
		{Op: proto.OpExecOuter, Argv: []string{"id"}, User: "app"},
	} {
		f, _ := request(t, s, req)
		var resp proto.ErrorResponse
		if json.Unmarshal(f.Payload, &resp) != nil || resp.Error == nil || resp.Error.Code != proto.ErrBadRequest {
			t.Fatalf("%+v: %s %q, want BAD_REQUEST", req, f.Type, f.Payload)
		}
	}
}

// TestOuterExecNeedsItsCgroup: with no outer cgroup (its setup failed),
// every outer exec is refused rather than run without its limits.
func TestOuterExecNeedsItsCgroup(t *testing.T) {
	s, inCgroup := newOuterServer(t)
	image := imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}})
	s.Outer = exec.NewStrictManager(launch.New(outsideRunner{direct: &proc.Direct{Reaper: reaper.New()}, inCgroup: inCgroup}, image, nil), nil)
	for _, tty := range []bool{false, true} {
		f, _ := request(t, s, proto.Request{Op: proto.OpExecOuter, Argv: []string{"true"}, TTY: tty})
		var resp proto.ErrorResponse
		if json.Unmarshal(f.Payload, &resp) != nil || resp.Error == nil || resp.Error.Code != proto.ErrExecFailed {
			t.Fatalf("tty %v: %s %q, want EXEC_FAILED", tty, f.Type, f.Payload)
		}
	}
	if len(inCgroup) != 0 {
		t.Fatal("a refused exec reached the runner")
	}
}
