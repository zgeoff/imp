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

	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
)

// TotalRecord is the PAX record on a created archive's first entry: the
// bytes of every regular file in it, for the CLI's progress.
const TotalRecord = "IMP.total"

// Run serves `imp-agent tar` with args after "tar".
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	image, err := imagecfg.Load()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	switch {
	case len(args) == 2 && args[0] == "create":
		path, err := resolve(args[1], image.User)
		if err != nil {
			return err
		}
		return Create(path, stdout, stderr)
	case len(args) >= 2 && args[0] == "extract":
		owner, dest := image.User, args[len(args)-1]
		switch {
		case len(args) == 4 && args[1] == "--owner":
			owner = args[2]
		case len(args) != 2:
			return usageError()
		}
		cred, _, err := proc.LookupUser(owner)
		if err != nil {
			return fmt.Errorf("owner %q: %w", owner, err)
		}
		path, err := resolve(dest, image.User)
		if err != nil {
			return err
		}
		return Extract(path, stdin, toOwner(cred), stderr)
	default:
		return usageError()
	}
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
func toOwner(cred *syscall.Credential) Owner {
	if cred == nil {
		return Owner{}
	}
	return Owner{UID: int(cred.Uid), GID: int(cred.Gid)}
}
