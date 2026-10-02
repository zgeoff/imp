// Package outer runs an exec in the agent's own world, outside the inner
// container: `imp exec --agent`, to see why the container is down or what
// is left on /user (docs/architecture/agent.md#outer-exec). It runs as
// root, with the busybox on the system drive.
package outer

import (
	"errors"
	"fmt"
	"os"
	"strconv"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/cgroup"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
)

const (
	// CgroupDir holds a leaf per outer exec. Its memory.max keeps a
	// runaway outer command from taking the memory the agent needs.
	CgroupDir = "/sys/fs/cgroup/outer"
	memoryMax = 32 << 20

	// RunDir is HOME and TMPDIR of an outer exec: a tmpfs of its own, as
	// the system drive is read-only and the agent's /run holds its sockets
	RunDir  = "/run/outer"
	runSize = "8m"

	// Command is the helper that starts each outer command: imp-agent
	// outer <path> <argv...>
	Command = "outer"
)

// Image is an outer exec's fixed config: the system drive's /bin, root and
// the cwd /.
func Image() *imagecfg.Live {
	return imagecfg.NewLive(imagecfg.Config{
		Env:     []string{"PATH=/bin", "HOME=" + RunDir, "TMPDIR=" + RunDir},
		Workdir: "/",
	})
}

// Setup makes the outer cgroup with its memory limit and mounts RunDir. An
// error leaves outer execs without a cgroup, so each one is refused.
func Setup() (*cgroup.Tree, error) {
	tree, err := cgroup.NewLimitedTree(CgroupDir, limitMemory)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(RunDir, 0o700); err != nil {
		return nil, err
	}
	if err := unix.Mount("tmpfs", RunDir, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0700,size="+runSize); err != nil {
		return nil, fmt.Errorf("mount %s: %w", RunDir, err)
	}
	return tree, nil
}

// limitMemory sets the outer cgroup's memory.max. Before each outer exec too:
// a root shell may have removed the cgroup, and the tree makes it again.
func limitMemory(dir string) error {
	if err := os.WriteFile(dir+"/memory.max", []byte(strconv.Itoa(memoryMax)), 0); err != nil {
		return fmt.Errorf("memory.max: %w", err)
	}
	return nil
}

// Runner starts outer commands through Next, the agent's own runner. Each
// one starts as the helper, in its cgroup leaf or not at all.
type Runner struct {
	Next proc.Runner
}

// Start resolves the command on the spec's PATH, so a missing one fails
// here as EXEC_FAILED, and starts the helper that execs it.
func (r Runner) Start(s proc.Spec) (*proc.Process, error) {
	if len(s.Argv) == 0 {
		return nil, errors.New("empty argv")
	}
	if s.Cgroup == nil {
		return nil, errors.New("an outer exec needs its cgroup")
	}
	path, err := proc.LookPath(s.Argv[0], s.Env)
	if err != nil {
		return nil, err
	}
	s.Argv = append([]string{"imp-agent", Command, path}, s.Argv...)
	s.Helper = true
	s.RequireCgroup = true
	return r.Next.Start(s)
}

// RunHelper is "imp-agent outer <path> <argv...>": it gives up the agent's
// shield from the OOM killer, which every child inherits, and becomes the
// command. Done in the child before the exec, nothing the command starts
// can inherit the shield.
func RunHelper(args []string) error {
	if len(args) < 2 {
		return errors.New("usage: imp-agent outer <path> <argv...>")
	}
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("0"), 0); err != nil {
		return err
	}
	return unix.Exec(args[0], args[1:], os.Environ())
}
