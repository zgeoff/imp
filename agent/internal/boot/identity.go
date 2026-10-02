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
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
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
// service starts. It returns what ping reports: impd keeps asking until a
// boot reports ok. See docs/guides/templates.md#identity.
func resetIdentity(r *reaper.Reaper, env []string) string {
	var keygen keygenFunc
	if path, err := proc.LookPath("ssh-keygen", env); err == nil {
		keygen = func(prefix string) error { return runKeygen(r, path, prefix, env) }
	}
	err := resetIdentityAt("/", keygen)
	// the new files must outlive a crash: impd stops asking after this boot
	unix.Sync()
	if err != nil {
		log.Printf("identity: %v", err)
		return proto.IdentityResetFailed
	}
	return proto.IdentityResetOK
}

func resetIdentityAt(root string, keygen keygenFunc) error {
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
func writeMachineID(root, id string) error {
	paths := []string{"etc/machine-id", "var/lib/dbus/machine-id"}
	for _, rel := range paths {
		p := filepath.Join(root, rel)
		fi, err := os.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !fi.Mode().IsRegular() || fi.Size() == 0 {
			continue
		}
		if err := writeFileAtomic(p, []byte(id+"\n"), fi.Mode().Perm()); err != nil {
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
func resetHostKeys(root string, keygen keygenFunc) error {
	dir := filepath.Join(root, "etc/ssh")
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	removeStaleStages(dir)
	if keygen == nil {
		log.Printf("identity: no ssh-keygen; ssh host keys kept")
		return nil
	}
	stage, err := os.MkdirTemp(dir, stagePrefix)
	if err != nil {
		return err
	}
	made := filepath.Join(stage, "etc/ssh")
	if err := os.MkdirAll(made, 0o755); err != nil {
		return err
	}
	if err := keygen(stage); err != nil {
		// a keygen that timed out may still write here: the next boot drops it
		return fmt.Errorf("ssh-keygen -A: %w", err)
	}
	defer os.RemoveAll(stage)
	keys, err := filepath.Glob(filepath.Join(made, "ssh_host_*"))
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return errors.New("ssh-keygen -A made no host keys")
	}
	kept := make(map[string]bool, len(keys))
	for _, k := range keys {
		name := filepath.Base(k)
		if err := os.Rename(k, filepath.Join(dir, name)); err != nil {
			return err
		}
		kept[name] = true
	}
	old, err := filepath.Glob(filepath.Join(dir, "ssh_host_*"))
	if err != nil {
		return err
	}
	for _, k := range old {
		if kept[filepath.Base(k)] {
			continue
		}
		if err := os.Remove(k); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// removeStaleStages drops what an earlier boot's keygen left behind.
func removeStaleStages(dir string) {
	stale, _ := filepath.Glob(filepath.Join(dir, stagePrefix+"*"))
	for _, s := range stale {
		os.RemoveAll(s)
	}
}

// runKeygen runs ssh-keygen -A -f prefix, which writes every missing default
// host key under prefix/etc/ssh.
func runKeygen(r *reaper.Reaper, path, prefix string, env []string) error {
	p, err := proc.Start(r, proc.Spec{
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
