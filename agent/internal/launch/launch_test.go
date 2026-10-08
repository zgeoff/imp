package launch

import (
	"os"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
)

func TestSpecRefusesAnEmptyArgv(t *testing.T) {
	l := New(&proc.Direct{}, imagecfg.NewLive(imagecfg.Config{User: "imp"}), nil)

	spec, err := l.Spec(proto.Request{Cwd: "/work"})

	assert.Check(t, cmp.ErrorContains(err, "argv is empty"))
	assert.Check(t, cmp.DeepEqual(spec, proc.Spec{}))
}

func TestSpecFillsTheImageDefaultsAroundTheRequest(t *testing.T) {
	l := New(&proc.Direct{}, imagecfg.NewLive(imagecfg.Config{
		Env:     []string{"PATH=/usr/bin", "LANG=C"},
		Workdir: "/app",
		User:    "imp",
	}), nil)

	spec, err := l.Spec(proto.Request{Argv: []string{"ls", "-l"}, Env: []string{"LANG=C.UTF-8"}, Cwd: "/tmp"})

	assert.NilError(t, err)
	assert.DeepEqual(t, spec, proc.Spec{
		Argv:    []string{"ls", "-l"},
		Env:     []string{"PATH=/usr/bin", "LANG=C.UTF-8"},
		Dir:     "/tmp",
		Workdir: "/app",
		User:    "imp",
		SetHome: true,
	})
}

func TestSpecRunsAsTheRequestedUserOverTheImageUser(t *testing.T) {
	l := New(&proc.Direct{}, imagecfg.NewLive(imagecfg.Config{User: "imp"}), nil)

	spec, err := l.Spec(proto.Request{Argv: []string{"id"}, User: "svc"})

	assert.NilError(t, err)
	assert.Equal(t, spec.User, "svc")
}

func TestStartPTYOpensNoPTYForAnEmptyArgv(t *testing.T) {
	opened := false
	l := New(&proc.Direct{}, imagecfg.NewLive(imagecfg.Config{}), func() (*os.File, *os.File, error) {
		opened = true
		return nil, nil, os.ErrInvalid
	})

	p, master, err := l.StartPTY(proto.Request{}, nil)

	assert.Check(t, cmp.ErrorContains(err, "argv is empty"))
	assert.Check(t, cmp.Nil(p))
	assert.Check(t, cmp.Nil(master))
	assert.Check(t, !opened, "opened a pty for a request it refused")
}
