package boot

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

func TestHostsWithNameMapsTheFirst127011LineToTheName(t *testing.T) {
	for _, tc := range []struct {
		name, in, want string
	}{
		{name: "empty", in: "", want: "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\tnew\n"},
		{name: "blank", in: "\n\n", want: "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\tnew\n"},
		{name: "renamed", in: "127.0.0.1 localhost\n127.0.1.1\told\n# keep\n", want: "127.0.0.1 localhost\n127.0.1.1\tnew\n# keep\n"},
		{name: "aliases dropped", in: "127.0.1.1 old old.local\n", want: "127.0.1.1\tnew\n"},
		{name: "duplicates collapse", in: "127.0.1.1 a\n10.0.0.1 db\n127.0.1.1 b\n", want: "127.0.1.1\tnew\n10.0.0.1 db\n"},
		{name: "appended", in: "127.0.0.1 localhost", want: "127.0.0.1 localhost\n127.0.1.1\tnew\n"},
		{name: "aliases kept", in: "127.0.1.1 new new.local\n", want: "127.0.1.1 new new.local\n"},
		{name: "unchanged", in: "127.0.0.1 localhost\n127.0.1.1\tnew\n", want: "127.0.0.1 localhost\n127.0.1.1\tnew\n"},
		// Only a 127.0.1.1 address field counts, not a mention in a comment.
		{name: "comment", in: "# 127.0.1.1 old\n", want: "# 127.0.1.1 old\n127.0.1.1\tnew\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, hostsWithName(tc.in, "new"), tc.want)
		})
	}
}

func TestUpdateHostsWritesADefaultFileWhenNoneExists(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hosts")

	err := updateHosts(fsroot.Host, p, "imp")

	assert.NilError(t, err)
	b, err := os.ReadFile(p)
	assert.NilError(t, err)
	assert.Equal(t, string(b), "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\timp\n")
}

func TestUpdateHostsReplacesTheFileWith0644AndLeavesNoTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "hosts")
	assert.NilError(t, os.WriteFile(p, []byte("127.0.1.1 old\n"), 0o600))

	err := updateHosts(fsroot.Host, p, "new")

	assert.NilError(t, err)
	b, err := os.ReadFile(p)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "127.0.1.1\tnew\n"))
	fi, err := os.Stat(p)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(fi.Mode().Perm(), os.FileMode(0o644)))
	ents, err := os.ReadDir(dir)
	assert.NilError(t, err)
	assert.Check(t, cmp.Len(ents, 1), "a temporary file was left behind: %v", ents)
}

func TestUpdateHostsWritesThroughASymlinkAndKeepsTheLink(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "real-hosts"), filepath.Join(dir, "hosts")
	assert.NilError(t, os.WriteFile(target, []byte("127.0.1.1 old\n"), 0o644))
	assert.NilError(t, os.Symlink("real-hosts", link))

	err := updateHosts(fsroot.Host, link, "new")

	assert.NilError(t, err)
	fi, err := os.Lstat(link)
	assert.NilError(t, err)
	assert.Check(t, fi.Mode()&os.ModeSymlink != 0, "the link was replaced")
	b, err := os.ReadFile(target)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "127.0.1.1\tnew\n"))
}

func TestUpdateHostsRefusesADanglingSymlinkAndKeepsIt(t *testing.T) {
	link := filepath.Join(t.TempDir(), "hosts")
	assert.NilError(t, os.Symlink("missing", link))

	err := updateHosts(fsroot.Host, link, "new")

	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
	fi, err := os.Lstat(link)
	assert.NilError(t, err)
	assert.Check(t, fi.Mode()&os.ModeSymlink != 0, "the link was replaced")
}

// A FIFO the user put behind /etc/hosts would block the boot, so it is
// refused rather than read or written.
func TestUpdateHostsRefusesASymlinkToAFIFOInTheContainerRoot(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.Mkdir(filepath.Join(dir, "etc"), 0o755))
	assert.NilError(t, unix.Mkfifo(filepath.Join(dir, "etc/fifo"), 0o644))
	assert.NilError(t, os.Symlink("fifo", filepath.Join(dir, "etc/hosts")))

	err := updateHosts(openRoot(t, dir), "/etc/hosts", "new")

	assert.ErrorIs(t, err, fsroot.ErrNotRegular)
}
