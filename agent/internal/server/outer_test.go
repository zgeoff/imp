package server

import (
	"path/filepath"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/cgroup"
	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/launch"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
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
	assert.NilError(t, err)
	image := imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}})
	inner := launch.New(downRunner{}, image, nil)
	inCgroup := make(chan bool, 1)
	outside := launch.New(outsideRunner{direct: &proc.Direct{Reaper: testReaper}, inCgroup: inCgroup}, image, nil)
	return &Server{
		Exec:     exec.NewManager(inner, nil),
		Outer:    exec.NewStrictManager(outside, tree),
		Sessions: session.NewManager(inner, ""),
	}, inCgroup
}

// replyCode reads the code of an error RESPONSE frame.
func replyCode(t *testing.T, f proto.Frame) string {
	t.Helper()
	assert.Assert(t, cmp.Equal(f.Type, proto.TypeResponse), "%q", f.Payload)
	return errorCode(t, f.Payload)
}

func TestPlainExecFindsTheInnerContainerDown(t *testing.T) {
	s, _ := newOuterServer(t)

	f, _ := request(t, s, proto.Request{Op: proto.OpExec, Argv: []string{"echo", "hi"}})

	assert.Equal(t, replyCode(t, f), proto.ErrInnerDown)
}

// exec.outer goes to the outer manager, in a leaf of its cgroup, while the
// inner container is down.
func TestOuterExecRunsInACgroupLeafWithTheContainerDown(t *testing.T) {
	for _, tc := range []struct {
		name string
		tty  bool
	}{
		{name: "pipes", tty: false},
		{name: "tty", tty: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, inCgroup := newOuterServer(t)

			f, conn := request(t, s, proto.Request{Op: proto.OpExecOuter, Argv: []string{"echo", "outside"}, TTY: tc.tty})

			assert.Assert(t, cmp.Equal(f.Type, proto.TypeStarted), "%q", f.Payload)
			assert.Check(t, <-inCgroup, "the outer exec started without a cgroup leaf")
			r := proto.NewReader(conn)
			var out strings.Builder
			for {
				f, err := r.Next()
				assert.NilError(t, err)
				if f.Type == proto.TypeStdout {
					out.Write(f.Payload)
				}
				if f.Type == proto.TypeExit {
					break
				}
			}
			assert.Check(t, cmp.Contains(out.String(), "outside"))
		})
	}
}

func TestOuterExecRefusesWhatOnlyAnInnerExecTakes(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  proto.Request
	}{
		{name: "a session", req: proto.Request{Op: proto.OpExecOuter, Argv: []string{"sh"}, TTY: true, Session: "main"}},
		{name: "a user", req: proto.Request{Op: proto.OpExecOuter, Argv: []string{"id"}, User: "app"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newOuterServer(t)

			f, _ := request(t, s, tc.req)

			assert.Equal(t, replyCode(t, f), proto.ErrBadRequest)
		})
	}
}

// With no outer cgroup (its setup failed), every outer exec is refused
// rather than run without its limits.
func TestOuterExecWithoutItsCgroupIsRefused(t *testing.T) {
	for _, tc := range []struct {
		name string
		tty  bool
	}{
		{name: "pipes", tty: false},
		{name: "tty", tty: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, inCgroup := newOuterServer(t)
			image := imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}})
			s.Outer = exec.NewStrictManager(launch.New(outsideRunner{direct: &proc.Direct{Reaper: testReaper}, inCgroup: inCgroup}, image, nil), nil)

			f, _ := request(t, s, proto.Request{Op: proto.OpExecOuter, Argv: []string{"true"}, TTY: tc.tty})

			assert.Check(t, cmp.Equal(replyCode(t, f), proto.ErrExecFailed))
			assert.Check(t, cmp.Len(inCgroup, 0), "a refused exec reached the runner")
		})
	}
}
