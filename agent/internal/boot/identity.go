package boot

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
)

// keygenTimeout bounds ssh-keygen -A; past it the old keys stay, the reset
// reports a failure, and the next boot tries again.
const keygenTimeout = 30 * time.Second

// stagePrefix names the directory under /etc/ssh where new host keys are
// made before they replace the old ones.
const stagePrefix = ".imp-hostkeys-"

// keygenFunc writes every default host key under prefix/etc/ssh.
type keygenFunc func(prefix string) error

// resetIdentity gives an imp made from a template its own machine-id and ssh
// host keys, on a boot impd asks it to (imp.reset_identity=1), before any
// service starts. root is the inner container's root, and ssh-keygen runs
// in the container. It returns what ping reports: impd keeps asking until a
// boot reports ok. See docs/guides/templates.md#identity.
func resetIdentity(runner proc.Runner, root fsroot.FS, env []string) string {
	var keygen keygenFunc
	if path, err := lookPathIn(root, "ssh-keygen", env); err == nil {
		keygen = func(prefix string) error { return runKeygen(runner, path, prefix, env) }
	}
	err := resetIdentityAt(root, keygen)
	// the new files must outlive a crash: impd stops asking after this boot
	unix.Sync()
	if err != nil {
		log.Printf("identity: %v", err)
		return proto.IdentityResetFailed
	}
	return proto.IdentityResetOK
}

func resetIdentityAt(root fsroot.FS, keygen keygenFunc) error {
	id, err := newMachineID()
	if err != nil {
		return err
	}
	return errors.Join(writeMachineID(root, id), resetHostKeys(root, keygen))
}

// newMachineID returns 32 lowercase hex digits, a random v4 UUID as
// systemd-machine-id-setup writes one.
func newMachineID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return hex.EncodeToString(b), nil
}

// writeMachineID replaces /etc/machine-id, and D-Bus's copy when it is a file
// of its own rather than a link to it. An empty or missing file stays as it
// is: the template holds no id to share.
func writeMachineID(root fsroot.FS, id string) error {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		fi, err := root.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !fi.Mode().IsRegular() || fi.Size() == 0 {
			continue
		}
		if err := fsroot.WriteFileAtomic(root, p, []byte(id+"\n"), fi.Mode().Perm()); err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
	}
	return nil
}

// resetHostKeys makes new host keys in a directory beside the old ones, then
// renames each into place and drops any old key of a type not made again.
// A keygen that fails or times out leaves the old keys, so sshd still starts.
// An image without /etc/ssh has no keys to reset; one without ssh-keygen
// keeps them (the guide says so).
func resetHostKeys(root fsroot.FS, keygen keygenFunc) error {
	const dir = "/etc/ssh"
	// a container that is down fails here, not as a missing ssh-keygen
	if _, err := root.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	removeStaleStages(root, dir)
	if keygen == nil {
		log.Printf("identity: no ssh-keygen; ssh host keys kept")
		return nil
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	stage := filepath.Join(dir, stagePrefix+hex.EncodeToString(suffix))
	made := filepath.Join(stage, "etc/ssh")
	if err := root.MkdirAll(made, 0o755); err != nil {
		return err
	}
	if err := keygen(stage); err != nil {
		// a keygen that timed out may still write here: the next boot drops it
		return fmt.Errorf("ssh-keygen -A: %w", err)
	}
	defer root.RemoveAll(stage)
	keys, err := listHostKeys(root, made)
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return errors.New("ssh-keygen -A made no host keys")
	}
	kept := make(map[string]bool, len(keys))
	for _, name := range keys {
		if err := root.Rename(filepath.Join(made, name), filepath.Join(dir, name)); err != nil {
			return err
		}
		kept[name] = true
	}
	old, err := listHostKeys(root, dir)
	if err != nil {
		return err
	}
	for _, name := range old {
		if kept[name] {
			continue
		}
		if err := root.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// listHostKeys names the ssh_host_* entries of dir.
func listHostKeys(root fsroot.FS, dir string) ([]string, error) {
	entries, err := root.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var keys []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "ssh_host_") {
			keys = append(keys, e.Name())
		}
	}
	return keys, nil
}

// removeStaleStages drops what an earlier boot's keygen left behind.
func removeStaleStages(root fsroot.FS, dir string) {
	entries, _ := root.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), stagePrefix) {
			root.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
}

// lookPathIn finds file in the PATH of env, as the container sees it.
func lookPathIn(root fsroot.FS, file string, env []string) (string, error) {
	for _, dir := range filepath.SplitList(proc.Get(env, "PATH")) {
		if !filepath.IsAbs(dir) {
			continue
		}
		p := filepath.Join(dir, file)
		if fi, err := root.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s: executable file not found in $PATH", file)
}

// runKeygen runs ssh-keygen -A -f prefix, which writes every missing default
// host key under prefix/etc/ssh.
func runKeygen(runner proc.Runner, path, prefix string, env []string) error {
	p, err := runner.Start(proc.Spec{
		Argv:  []string{path, "-A", "-f", prefix},
		Env:   env,
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
	})
	if err != nil {
		return err
	}
	select {
	case st := <-p.Done:
		if st.Code != 0 {
			return fmt.Errorf("exit %d, signal %d", st.Code, st.Signal)
		}
		return nil
	case <-time.After(keygenTimeout):
		return fmt.Errorf("still running after %s", keygenTimeout)
	}
}
