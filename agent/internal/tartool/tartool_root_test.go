//go:build root

// The tests that chown, so they need root: run them with -tags root as root.

package tartool

import (
	"archive/tar"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

// ownership maps each name under dir to its uid:gid, without following
// symlinks.
func ownership(t *testing.T, dir string, names ...string) map[string][2]uint32 {
	t.Helper()
	got := map[string][2]uint32{}
	for _, name := range names {
		var st syscall.Stat_t
		assert.NilError(t, syscall.Lstat(filepath.Join(dir, name), &st))
		got[name] = [2]uint32{st.Uid, st.Gid}
	}
	return got
}

// As root: every entry the copy makes belongs to the owner; a directory
// that was there keeps its own
func TestExtractGivesEveryEntryToTheOwner(t *testing.T) {
	dir := t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		fileEntry("src/a", "x"),
		tar.Header{Typeflag: tar.TypeSymlink, Name: "src/l", Linkname: "a"},
	)

	err := Extract(dir, archive, &Owner{UID: 4242, GID: 4343}, io.Discard)

	assert.NilError(t, err)
	assert.Check(t, cmp.DeepEqual(ownership(t, dir, "src", "src/a", "src/l"), map[string][2]uint32{
		"src":   {4242, 4343},
		"src/a": {4242, 4343},
		"src/l": {4242, 4343},
	}))
	assert.Check(t, cmp.DeepEqual(ownership(t, dir, "."), map[string][2]uint32{".": {0, 0}}))
}

// As root: with no owner, the copy belongs to the owner of the directory it
// lands in
func TestExtractWithNoOwnerGivesTheCopyToTheDirectorysOwner(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.Chown(dir, 4242, 4343))
	archive := buildArchive(t, dirEntry("src/"), fileEntry("src/a", "x"))

	err := Extract(dir, archive, nil, io.Discard)

	assert.NilError(t, err)
	assert.DeepEqual(t, ownership(t, dir, "src", "src/a"), map[string][2]uint32{
		"src":   {4242, 4343},
		"src/a": {4242, 4343},
	})
}
