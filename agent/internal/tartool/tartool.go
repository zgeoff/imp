// Package tartool is `imp-agent tar`, the guest end of `imp cp`. impd runs it
// from the system drive as root, so it reads and writes any path, and every
// image has it without a tar of its own:
//
//	imp-agent tar create <path>                  # a tar of path on stdout
//	imp-agent tar extract [--owner SPEC] <dest>  # stdin's tar into dest
//
// A relative path resolves against the image USER's home, as scp's does.
// See docs/guides/cp.md.
package tartool

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
)

// TotalRecord is the PAX record on a created archive's first entry: the
// bytes of every regular file in it, for the CLI's progress.
const TotalRecord = "IMP.total"

// Command is one `imp-agent tar` invocation as impd sends it: an op of
// create or extract, its path, and for an extract the owner spec, if any.
type Command struct {
	Op    string
	Path  string
	Owner string
}

// ParseArgs reads the args after "tar"; anything outside the usage fails.
func ParseArgs(args []string) (Command, error) {
	switch {
	case len(args) == 2 && args[0] == "create":
		return Command{Op: "create", Path: args[1]}, nil
	case len(args) == 2 && args[0] == "extract":
		return Command{Op: "extract", Path: args[1]}, nil
	case len(args) == 4 && args[0] == "extract" && args[1] == "--owner":
		return Command{Op: "extract", Path: args[3], Owner: args[2]}, nil
	default:
		return Command{}, usageError()
	}
}

// Run serves `imp-agent tar` with args after "tar".
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	cmd, err := ParseArgs(args)
	if err != nil {
		return err
	}
	// it runs in the container, where the host view is the user's root
	image, err := imagecfg.Load(fsroot.Host)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	path, err := resolve(cmd.Path, image.User)
	if err != nil {
		return err
	}
	if cmd.Op == "create" {
		return Create(path, stdout, stderr)
	}
	var owner *Owner
	if cmd.Owner != "" {
		cred, _, err := proc.LookupUser(cmd.Owner)
		if err != nil {
			return fmt.Errorf("owner %q: %w", cmd.Owner, err)
		}
		owner = toOwner(cred)
	}
	return Extract(path, stdin, owner, stderr)
}

func usageError() error {
	return errors.New("usage: imp-agent tar create <path> | extract [--owner SPEC] <dest>")
}

// resolve makes path absolute against user's home.
func resolve(path, user string) (string, error) {
	if path == "" {
		return "", errors.New("an empty path")
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	_, home, err := proc.LookupUser(user)
	if err != nil {
		return "", fmt.Errorf("user %q: %w", user, err)
	}
	return filepath.Join(home, path), nil
}

// Owner is who extracted entries belong to.
type Owner struct {
	UID, GID int
}

// root is a nil credential
func toOwner(cred *syscall.Credential) *Owner {
	if cred == nil {
		return &Owner{}
	}
	return &Owner{UID: int(cred.Uid), GID: int(cred.Gid)}
}
