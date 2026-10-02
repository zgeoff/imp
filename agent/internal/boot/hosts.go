package boot

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

// updateHosts points the 127.0.1.1 line of the hosts file at name. It runs
// every boot, because a fork or rename gives the imp a new hostname on the
// same disk. OCI exports leave /etc/hosts empty (Docker bind-mounts it at
// run time), so an empty or missing file gets a default one. A symlinked
// hosts file is updated at its target, which resolves inside fsys; the
// rename must not replace the link.
func updateHosts(fsys fsroot.FS, path, name string) error {
	isLink := false
	if fi, err := fsys.Lstat(path); err == nil && fi.Mode()&fs.ModeSymlink != 0 {
		if _, err := fsys.Stat(path); err != nil {
			return fmt.Errorf("%s is a symlink that does not resolve: %w", path, err)
		}
		isLink = true
	}
	b, err := fsys.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	out := hostsWithName(string(b), name)
	if out == string(b) {
		return nil
	}
	if isLink {
		// in place, through the link
		f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
		if err != nil {
			return err
		}
		_, err = f.WriteString(out)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		return err
	}
	return fsroot.WriteFileAtomic(fsys, path, []byte(out), 0o644)
}

// hostsWithName returns hosts with its first 127.0.1.1 line mapping to
// name, or with such a line appended if there is none. A line that already
// names it first keeps its aliases; later 127.0.1.1 lines are dropped.
func hostsWithName(hosts, name string) string {
	line := "127.0.1.1\t" + name
	if strings.TrimSpace(hosts) == "" {
		return "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n" + line + "\n"
	}
	lines := strings.Split(strings.TrimSuffix(hosts, "\n"), "\n")
	out := make([]string, 0, len(lines)+1)
	replaced := false
	for _, l := range lines {
		if f := strings.Fields(l); len(f) > 0 && f[0] == "127.0.1.1" {
			if !replaced {
				if len(f) > 1 && f[1] == name {
					out = append(out, l)
				} else {
					out = append(out, line)
				}
				replaced = true
			}
			continue
		}
		out = append(out, l)
	}
	if !replaced {
		out = append(out, line)
	}
	return strings.Join(out, "\n") + "\n"
}
