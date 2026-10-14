package server

import (
	"os"
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

// A plain directory is no cgroup, so a start that must use it fails unless
// the runner drops it.
func TestOutsideRunnerRecordsTheCgroupItWasGivenAndStartsWithoutIt(t *testing.T) {
	dir, err := os.Open(t.TempDir())
	assert.NilError(t, err)
	t.Cleanup(func() { dir.Close() })
	inCgroup := make(chan bool, 1)
	r := outsideRunner{direct: &proc.Direct{Reaper: testReaper}, inCgroup: inCgroup}

	p, err := r.Start(proc.Spec{Argv: []string{"/bin/true"}, Dir: "/", Cgroup: dir, RequireCgroup: true})

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(<-inCgroup, true), "the given cgroup was not recorded")
	assert.Check(t, !p.InCgroup, "the process started in the cgroup")
	assert.Check(t, cmp.Equal((<-p.Done).Code, 0))
}

func TestOutsideRunnerRecordsAStartWithoutACgroup(t *testing.T) {
	inCgroup := make(chan bool, 1)
	r := outsideRunner{direct: &proc.Direct{Reaper: testReaper}, inCgroup: inCgroup}

	p, err := r.Start(proc.Spec{Argv: []string{"/bin/true"}, Dir: "/"})

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(<-inCgroup, false), "a start without a cgroup recorded one")
	assert.Check(t, cmp.Equal((<-p.Done).Code, 0))
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

	f, _ := request(t, s, &proto.Request{Op: proto.OpExec, Argv: []string{"echo", "hi"}})

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

			f, conn := request(t, s, &proto.Request{Op: proto.OpExecOuter, Argv: []string{"echo", "outside"}, Tty: new(tc.tty)})

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
		req  *proto.Request
	}{
		{name: "a session", req: &proto.Request{Op: proto.OpExecOuter, Argv: []string{"sh"}, Tty: new(true), Session: new("main")}},
		{name: "a user", req: &proto.Request{Op: proto.OpExecOuter, Argv: []string{"id"}, User: new("app")}},
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

			f, _ := request(t, s, &proto.Request{Op: proto.OpExecOuter, Argv: []string{"true"}, Tty: new(tc.tty)})

			assert.Check(t, cmp.Equal(replyCode(t, f), proto.ErrExecFailed))
			assert.Check(t, cmp.Len(inCgroup, 0), "a refused exec reached the runner")
		})
	}
}
