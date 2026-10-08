package boot

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

func TestNewMachineIDIsAFreshVersion4UUIDInHexEachCall(t *testing.T) {
	a, err := newMachineID()
	assert.NilError(t, err)
	b, err := newMachineID()
	assert.NilError(t, err)

	assert.Check(t, cmp.Regexp(`^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$`, a))
	assert.Check(t, a != b, "two ids are both %q", a)
}

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, text := range files {
		p := filepath.Join(root, rel)
		assert.NilError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		assert.NilError(t, os.WriteFile(p, []byte(text), 0o444))
	}
}

// openRoot opens dir as the container's root would be.
func openRoot(t *testing.T, dir string) *fsroot.Root {
	t.Helper()
	root, err := fsroot.Open(dir)
	assert.NilError(t, err)
	t.Cleanup(func() { root.Close() })
	return root
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	assert.NilError(t, err)
	return string(b)
}

func TestWriteMachineIDReplacesBothCopiesAndKeepsTheirMode(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"etc/machine-id":          "old\n",
		"var/lib/dbus/machine-id": "old\n",
	})

	err := writeMachineID(openRoot(t, root), "new")

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(root, "etc/machine-id")), "new\n"))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(root, "var/lib/dbus/machine-id")), "new\n"))
	fi, err := os.Stat(filepath.Join(root, "etc/machine-id"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(fi.Mode().Perm(), os.FileMode(0o444)), "want the file's own 0444")
}

// A link to /etc/machine-id follows it; an empty file stays: the template
// holds no id to share.
func TestWriteMachineIDLeavesAnEmptyFileAndALinkToItAlone(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"etc/machine-id": ""})
	dbus := filepath.Join(root, "var/lib/dbus/machine-id")
	assert.NilError(t, os.MkdirAll(filepath.Dir(dbus), 0o755))
	assert.NilError(t, os.Symlink("/etc/machine-id", dbus))

	err := writeMachineID(openRoot(t, root), "new")

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(root, "etc/machine-id")), ""))
	target, err := os.Readlink(dbus)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(target, "/etc/machine-id"))
}

func TestWriteMachineIDSucceedsWhenNeitherFileExists(t *testing.T) {
	root := t.TempDir()

	err := writeMachineID(openRoot(t, root), "new")

	assert.NilError(t, err)
}

// fakeKeygen writes the named keys under prefix/etc/ssh, as ssh-keygen -A -f
// prefix does in the container whose root is the directory root.
func fakeKeygen(root string, names ...string) keygenFunc {
	return func(prefix string) error {
		for _, n := range names {
			if err := os.WriteFile(filepath.Join(root, prefix, "etc/ssh", n), []byte("new"), 0o600); err != nil {
				return err
			}
		}
		return nil
	}
}

func listSSH(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root, "etc/ssh"))
	assert.NilError(t, err)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestFakeKeygenWritesTheNamedKeysUnderThePrefix(t *testing.T) {
	root := t.TempDir()
	assert.NilError(t, os.MkdirAll(filepath.Join(root, "stage/etc/ssh"), 0o755))

	err := fakeKeygen(root, "ssh_host_ed25519_key", "ssh_host_ed25519_key.pub")("/stage")

	assert.NilError(t, err)
	entries, err := os.ReadDir(filepath.Join(root, "stage/etc/ssh"))
	assert.NilError(t, err)
	names := []string{}
	for _, e := range entries {
		names = append(names, e.Name())
	}
	assert.Check(t, cmp.DeepEqual(names, []string{"ssh_host_ed25519_key", "ssh_host_ed25519_key.pub"}))
}

// New keys replace the old, an old key of a type not made again goes, other
// files stay, and a crashed boot's stage is dropped.
func TestResetHostKeysSwapsInTheNewKeys(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"etc/ssh/ssh_host_ed25519_key":     "old",
		"etc/ssh/ssh_host_ed25519_key.pub": "old",
		"etc/ssh/ssh_host_dsa_key":         "old",
		"etc/ssh/sshd_config":              "c",
		"etc/ssh/.imp-hostkeys-left/x":     "a crashed boot's stage",
	})

	err := resetHostKeys(openRoot(t, root), fakeKeygen(root, "ssh_host_ed25519_key", "ssh_host_ed25519_key.pub"))

	assert.NilError(t, err)
	assert.Check(t, cmp.DeepEqual(listSSH(t, root), []string{"ssh_host_ed25519_key", "ssh_host_ed25519_key.pub", "sshd_config"}))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(root, "etc/ssh/ssh_host_ed25519_key")), "new"))
}

// A keygen that fails leaves every old key, so sshd still starts.
func TestResetHostKeysKeepsTheOldKeysWhenKeygenFails(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"etc/ssh/ssh_host_ed25519_key": "old"})
	timedOut := errors.New("timed out")

	err := resetHostKeys(openRoot(t, root), func(string) error { return timedOut })

	assert.Check(t, cmp.ErrorIs(err, timedOut))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(root, "etc/ssh/ssh_host_ed25519_key")), "old"))
}

func TestResetHostKeysKeepsTheOldKeysWhenKeygenMakesNone(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"etc/ssh/ssh_host_ed25519_key": "old"})

	err := resetHostKeys(openRoot(t, root), fakeKeygen(root))

	assert.Check(t, cmp.ErrorContains(err, "ssh-keygen -A made no host keys"))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(root, "etc/ssh/ssh_host_ed25519_key")), "old"))
}

func TestResetHostKeysDoesNothingWithoutEtcSSH(t *testing.T) {
	root := t.TempDir()

	err := resetHostKeys(openRoot(t, root), nil)

	assert.NilError(t, err)
}

func TestResetHostKeysKeepsTheKeysWithoutSSHKeygen(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"etc/ssh/ssh_host_rsa_key": "old"})

	err := resetHostKeys(openRoot(t, root), nil)

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(root, "etc/ssh/ssh_host_rsa_key")), "old"))
}

// The machine-id still changes when the host keys fail, and the failure is
// reported.
func TestResetIdentityAtReportsAKeygenFailureAndStillWritesTheMachineID(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"etc/machine-id":           "old\n",
		"etc/ssh/ssh_host_rsa_key": "old",
	})
	boom := errors.New("boom")

	err := resetIdentityAt(openRoot(t, root), func(string) error { return boom })

	assert.Check(t, cmp.ErrorIs(err, boom))
	assert.Check(t, cmp.Regexp(`^[0-9a-f]{32}\n$`, readFile(t, filepath.Join(root, "etc/machine-id"))))
}

// ssh-keygen is looked up in the container's files, by the image's PATH: the
// first executable match wins.
func TestLookPathInFindsTheFirstExecutableOnThePath(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"usr/bin/ssh-keygen": "#!/bin/sh\n", "bin/ssh-keygen": "#!/bin/sh\n"})
	assert.NilError(t, os.Chmod(filepath.Join(root, "usr/bin/ssh-keygen"), 0o755))

	got, err := lookPathIn(openRoot(t, root), "ssh-keygen", []string{"PATH=/bin:/usr/bin"})

	assert.NilError(t, err)
	assert.Equal(t, got, "/usr/bin/ssh-keygen")
}

func TestLookPathInFailsForAFileOutsideThePath(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"usr/bin/ssh-keygen": "#!/bin/sh\n"})
	assert.NilError(t, os.Chmod(filepath.Join(root, "usr/bin/ssh-keygen"), 0o755))

	_, err := lookPathIn(openRoot(t, root), "ssh-keygen", []string{"PATH=/sbin"})

	assert.ErrorContains(t, err, "ssh-keygen: executable file not found in $PATH")
}
