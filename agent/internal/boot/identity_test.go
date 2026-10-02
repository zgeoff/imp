package boot

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

func TestNewMachineID(t *testing.T) {
	a, err := newMachineID()
	if err != nil {
		t.Fatal(err)
	}
	b, err := newMachineID()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$`).MatchString(a) {
		t.Fatalf("id %q is not a v4 UUID in 32 hex digits", a)
	}
	if a == b {
		t.Fatalf("two ids are both %q", a)
	}
}

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, text := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o444); err != nil {
			t.Fatal(err)
		}
	}
}

// openRoot opens dir as the container's root would be.
func openRoot(t *testing.T, dir string) *fsroot.Root {
	t.Helper()
	root, err := fsroot.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return root
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestWriteMachineID(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"etc/machine-id":          "old\n",
		"var/lib/dbus/machine-id": "old\n",
	})
	if err := writeMachineID(openRoot(t, root), "new"); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"etc/machine-id", "var/lib/dbus/machine-id"} {
		if got := readFile(t, filepath.Join(root, rel)); got != "new\n" {
			t.Fatalf("%s = %q", rel, got)
		}
	}
	fi, err := os.Stat(filepath.Join(root, "etc/machine-id"))
	if err != nil || fi.Mode().Perm() != 0o444 {
		t.Fatalf("mode %v, err %v; want the file's own 0444", fi.Mode(), err)
	}
}

// A link to /etc/machine-id follows it; an empty or missing file stays.
func TestWriteMachineIDLeavesLinksAndEmptyFiles(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"etc/machine-id": ""})
	dbus := filepath.Join(root, "var/lib/dbus/machine-id")
	if err := os.MkdirAll(filepath.Dir(dbus), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/machine-id", dbus); err != nil {
		t.Fatal(err)
	}
	if err := writeMachineID(openRoot(t, root), "new"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(root, "etc/machine-id")); got != "" {
		t.Fatalf("empty machine-id became %q", got)
	}
	if target, err := os.Readlink(dbus); err != nil || target != "/etc/machine-id" {
		t.Fatalf("dbus link = %q, %v", target, err)
	}
	if err := writeMachineID(openRoot(t, t.TempDir()), "new"); err != nil {
		t.Fatalf("no files: %v", err)
	}
}

// fakeKeygen writes the named keys under prefix/etc/ssh, as ssh-keygen -A -f
// prefix does in the container whose root is the directory root.
func fakeKeygen(t *testing.T, root string, names ...string) keygenFunc {
	return func(prefix string) error {
		for _, n := range names {
			if err := os.WriteFile(filepath.Join(root, prefix, "etc/ssh", n), []byte("new"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return nil
	}
}

func listSSH(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root, "etc/ssh"))
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestResetHostKeysSwapsInNewKeys(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"etc/ssh/ssh_host_ed25519_key":     "old",
		"etc/ssh/ssh_host_ed25519_key.pub": "old",
		"etc/ssh/ssh_host_dsa_key":         "old",
		"etc/ssh/sshd_config":              "c",
		"etc/ssh/.imp-hostkeys-left/x":     "a crashed boot's stage",
	})
	err := resetHostKeys(openRoot(t, root), fakeKeygen(t, root, "ssh_host_ed25519_key", "ssh_host_ed25519_key.pub"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ssh_host_ed25519_key", "ssh_host_ed25519_key.pub", "sshd_config"}
	if got := listSSH(t, root); !reflect.DeepEqual(got, want) {
		t.Fatalf("/etc/ssh = %v, want %v", got, want)
	}
	if got := readFile(t, filepath.Join(root, "etc/ssh/ssh_host_ed25519_key")); got != "new" {
		t.Fatalf("key = %q", got)
	}
}

// A keygen that fails leaves every old key, so sshd still starts.
func TestResetHostKeysKeepsOldKeysOnFailure(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"etc/ssh/ssh_host_ed25519_key": "old"})
	err := resetHostKeys(openRoot(t, root), func(string) error { return errors.New("timed out") })
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v", err)
	}
	if got := readFile(t, filepath.Join(root, "etc/ssh/ssh_host_ed25519_key")); got != "old" {
		t.Fatalf("key = %q", got)
	}
	if err := resetHostKeys(openRoot(t, root), fakeKeygen(t, root)); err == nil {
		t.Fatal("a keygen that made no keys passed")
	}
}

func TestResetHostKeysWithoutKeygenOrSSH(t *testing.T) {
	root := t.TempDir()
	if err := resetHostKeys(openRoot(t, root), nil); err != nil {
		t.Fatalf("no /etc/ssh: %v", err)
	}
	writeTree(t, root, map[string]string{"etc/ssh/ssh_host_rsa_key": "old"})
	if err := resetHostKeys(openRoot(t, root), nil); err != nil {
		t.Fatalf("no ssh-keygen: %v", err)
	}
	if got := readFile(t, filepath.Join(root, "etc/ssh/ssh_host_rsa_key")); got != "old" {
		t.Fatalf("key = %q", got)
	}
}

func TestResetIdentityAtJoinsFailures(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"etc/machine-id":           "old\n",
		"etc/ssh/ssh_host_rsa_key": "old",
	})
	err := resetIdentityAt(openRoot(t, root), func(string) error { return errors.New("boom") })
	if err == nil {
		t.Fatal("a failed keygen reported success")
	}
	// the machine-id still changed
	if got := readFile(t, filepath.Join(root, "etc/machine-id")); got == "old\n" {
		t.Fatal("machine-id kept")
	}
}

// ssh-keygen is looked up in the container's files, by the image's PATH.
func TestLookPathIn(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"usr/bin/ssh-keygen": "#!/bin/sh\n", "bin/ssh-keygen": "#!/bin/sh\n"})
	if err := os.Chmod(filepath.Join(root, "usr/bin/ssh-keygen"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := openRoot(t, root)
	got, err := lookPathIn(r, "ssh-keygen", []string{"PATH=/bin:/usr/bin"})
	if err != nil || got != "/usr/bin/ssh-keygen" {
		t.Fatalf("got %q, %v; want the executable /usr/bin/ssh-keygen", got, err)
	}
	if _, err := lookPathIn(r, "ssh-keygen", []string{"PATH=/sbin"}); err == nil {
		t.Fatal("found ssh-keygen outside PATH")
	}
}
