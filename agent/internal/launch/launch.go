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
	"github.com/zgeoff/imp/agent/internal/reaper"
)

// The pty size when the request gives none.
const (
	defaultCols = 80
	defaultRows = 24
)

type Launcher struct {
	reaper *reaper.Reaper
	image  imagecfg.Config
}

func New(r *reaper.Reaper, image imagecfg.Config) *Launcher {
	return &Launcher{reaper: r, image: image}
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
	// HOME must be the user's before cwd falls back to it.
	env, err := proc.UserEnv(proc.Merge(l.image.Env, req.Env), user)
	if err != nil {
		return proc.Spec{}, err
	}
	return proc.Spec{Argv: req.Argv, Env: env, Dir: l.cwd(req, env), User: user}, nil
}

// Start starts spec through the reaper.
func (l *Launcher) Start(spec proc.Spec) (*proc.Process, error) {
	return proc.Start(l.reaper, spec)
}

// StartPTY starts req on a new pty, sized from req, and returns the process
// and the pty master. The child's end of the pty is closed here.
func (l *Launcher) StartPTY(req proto.Request) (*proc.Process, *os.File, error) {
	spec, err := l.Spec(req)
	if err != nil {
		return nil, nil, err
	}
	master, slave, err := pty.Open()
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

// cwd picks the request's cwd, else the image workdir, else $HOME. Only an
// explicit request cwd is allowed to fail; defaults fall back to /.
func (l *Launcher) cwd(req proto.Request, env []string) string {
	if req.Cwd != "" {
		return req.Cwd
	}
	for _, d := range []string{l.image.Workdir, proc.Get(env, "HOME")} {
		if fi, err := os.Stat(d); d != "" && err == nil && fi.IsDir() {
			return d
		}
	}
	return "/"
}
