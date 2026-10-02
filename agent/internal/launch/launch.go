// Package launch turns an exec request into a process: the image's default
// env, user and cwd, and a new pty when the request asks for one. Exec and
// sessions both start their processes here.
package launch

import (
	"errors"
	"log"
	"os"

	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/pty"
)

// The pty size when the request gives none.
const (
	defaultCols = 80
	defaultRows = 24
)

type Launcher struct {
	runner proc.Runner
	image  imagecfg.Config
	// ptys opens a pty in the world the runner starts processes in
	ptys func() (master, slave *os.File, err error)
}

// New starts processes through runner, on ptys that openPTY makes; nil
// opens them in this process's own /dev.
func New(runner proc.Runner, image imagecfg.Config, openPTY func() (master, slave *os.File, err error)) *Launcher {
	if openPTY == nil {
		openPTY = pty.Open
	}
	return &Launcher{runner: runner, image: image, ptys: openPTY}
}

// Spec resolves req's argv, env, cwd and user. The caller sets Files and TTY.
func (l *Launcher) Spec(req proto.Request) (proc.Spec, error) {
	if len(req.Argv) == 0 {
		return proc.Spec{}, errors.New("argv is empty")
	}
	user := req.User
	if user == "" {
		user = l.image.User
	}
	// HOME is the user's, and the cwd falls back to the image workdir and
	// HOME, where the process starts.
	return proc.Spec{
		Argv:    req.Argv,
		Env:     proc.Merge(l.image.Env, req.Env),
		Dir:     req.Cwd,
		Workdir: l.image.Workdir,
		User:    user,
		SetHome: true,
	}, nil
}

// Start starts spec through the reaper.
func (l *Launcher) Start(spec proc.Spec) (*proc.Process, error) {
	return l.runner.Start(spec)
}

// StartPTY starts req on a new pty, sized from req, and returns the process
// and the pty master. The child's end of the pty is closed here.
func (l *Launcher) StartPTY(req proto.Request) (*proc.Process, *os.File, error) {
	spec, err := l.Spec(req)
	if err != nil {
		return nil, nil, err
	}
	master, slave, err := l.ptys()
	if err != nil {
		return nil, nil, err
	}
	cols, rows := req.Cols, req.Rows
	if cols == 0 || rows == 0 {
		cols, rows = defaultCols, defaultRows
	}
	if err := pty.SetWinsize(master, cols, rows); err != nil {
		log.Printf("launch: winsize: %v", err)
	}
	spec.TTY = true
	spec.Files = []*os.File{slave, slave, slave}
	p, err := l.Start(spec)
	slave.Close()
	if err != nil {
		master.Close()
		return nil, nil, err
	}
	return p, master, nil
}
