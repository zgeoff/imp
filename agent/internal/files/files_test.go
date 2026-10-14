package files

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/proto"
)

func TestWriteCreatesTheParentsAndAReadOnlyFile(t *testing.T) {
	dir := t.TempDir()

	err := New(dir).Write("notes/drafts/today.json", []byte(`{"title":"kettle"}`))

	assert.NilError(t, err)
	fi, err := os.Stat(filepath.Join(dir, "notes/drafts/today.json"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(fi.Mode().Perm(), os.FileMode(0o444)))
	parent, err := os.Stat(filepath.Join(dir, "notes/drafts"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(parent.Mode().Perm(), os.FileMode(0o755)))
	b, err := os.ReadFile(filepath.Join(dir, "notes/drafts/today.json"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), `{"title":"kettle"}`))
}

func TestWriteReplacesAFileThroughARenameAndLeavesNoStagedFile(t *testing.T) {
	dir := t.TempDir()
	store := New(dir)
	assert.NilError(t, store.Write("notes/today.json", []byte(`{"revision":1}`)))
	held, err := os.Open(filepath.Join(dir, "notes/today.json"))
	assert.NilError(t, err)
	t.Cleanup(func() { held.Close() })

	err = store.Write("notes/today.json", []byte(`{"revision":2}`))

	assert.NilError(t, err)
	// a reader that opened the old file keeps it whole: the new one is a new inode
	old := make([]byte, 64)
	n, err := held.Read(old)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(old[:n]), `{"revision":1}`))
	b, err := os.ReadFile(filepath.Join(dir, "notes/today.json"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), `{"revision":2}`))
	entries, err := os.ReadDir(filepath.Join(dir, "notes"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Len(entries, 1))
}

func TestWriteRefusesDataOverTheCap(t *testing.T) {
	dir := t.TempDir()

	err := New(dir).Write("big.json", make([]byte, MaxData+1))

	assert.Check(t, cmp.ErrorType(err, &proto.Error{}))
	assert.Check(t, cmp.Equal(err.(*proto.Error).Code, proto.ErrBadRequest))
	_, statErr := os.Stat(filepath.Join(dir, "big.json"))
	assert.Check(t, os.IsNotExist(statErr))
}

func TestWriteTakesDataAtTheCap(t *testing.T) {
	dir := t.TempDir()

	err := New(dir).Write("big.json", make([]byte, MaxData))

	assert.NilError(t, err)
}

func TestWriteRefusesAPathThatIsADirectory(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.MkdirAll(filepath.Join(dir, "notes/today.json"), 0o755))

	err := New(dir).Write("notes/today.json", []byte("{}"))

	assert.Check(t, cmp.Equal(err.(*proto.Error).Code, proto.ErrBadRequest))
}

func TestWriteRefusesAPathUnderAFile(t *testing.T) {
	dir := t.TempDir()
	store := New(dir)
	assert.NilError(t, store.Write("notes", []byte("{}")))

	err := store.Write("notes/today.json", []byte("{}"))

	assert.Check(t, cmp.Equal(err.(*proto.Error).Code, proto.ErrBadRequest))
}

func TestWriteNeverFollowsASymlinkAtThePath(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	assert.NilError(t, os.WriteFile(filepath.Join(outside, "keep"), []byte("outside"), 0o644))
	assert.NilError(t, os.Symlink(filepath.Join(outside, "keep"), filepath.Join(dir, "today.json")))

	err := New(dir).Write("today.json", []byte("{}"))

	assert.Check(t, cmp.Equal(err.(*proto.Error).Code, proto.ErrBadRequest))
	b, err := os.ReadFile(filepath.Join(outside, "keep"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "outside"))
}

func TestWriteNeverLeavesTheTreeThroughASymlinkedDirectory(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	assert.NilError(t, os.Symlink(outside, filepath.Join(dir, "notes")))

	// the link resolves inside the tree, wherever it points
	_ = New(dir).Write("notes/today.json", []byte("{}"))

	entries, err := os.ReadDir(outside)
	assert.NilError(t, err)
	assert.Check(t, cmp.Len(entries, 0))
}

func TestWriteRefusesABadPath(t *testing.T) {
	cases := []string{
		"",
		"/notes/today.json",
		"notes//today.json",
		"notes/",
		"../today.json",
		"notes/../today.json",
		"./today.json",
		".today.json",
		"notes/.staged",
		"no spaces.json",
		"a/b/c/d/e/f/g/h/i",
		strings.Repeat("a", 129),
		strings.Repeat("abcdefgh/", 57) + "x",
	}
	for _, p := range cases {
		t.Run(p, func(t *testing.T) {
			err := New(t.TempDir()).Write(p, []byte("{}"))

			assert.Check(t, cmp.ErrorType(err, &proto.Error{}))
			assert.Check(t, cmp.Equal(err.(*proto.Error).Code, proto.ErrBadRequest))
		})
	}
}

func TestWriteTakesAGoodPath(t *testing.T) {
	cases := []string{
		"today.json",
		"_.json",
		"a/b/c/d/e/f/g/h",
		"records/0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30.json",
		strings.Repeat("a", 128),
	}
	for _, p := range cases {
		t.Run(p, func(t *testing.T) {
			err := New(t.TempDir()).Write(p, []byte("{}"))

			assert.NilError(t, err)
		})
	}
}

func TestRemoveRemovesAFileAndReportsIt(t *testing.T) {
	dir := t.TempDir()
	store := New(dir)
	assert.NilError(t, store.Write("notes/today.json", []byte("{}")))

	removed, err := store.Remove("notes/today.json")

	assert.NilError(t, err)
	assert.Check(t, removed)
	_, statErr := os.Stat(filepath.Join(dir, "notes/today.json"))
	assert.Check(t, os.IsNotExist(statErr))
	_, statErr = os.Stat(filepath.Join(dir, "notes"))
	assert.NilError(t, statErr)
}

func TestRemoveReportsAMissingFileAsNotRemoved(t *testing.T) {
	removed, err := New(t.TempDir()).Remove("notes/today.json")

	assert.NilError(t, err)
	assert.Check(t, !removed)
}

func TestRemoveRefusesADirectory(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.MkdirAll(filepath.Join(dir, "notes"), 0o755))

	_, err := New(dir).Remove("notes")

	assert.Check(t, cmp.Equal(err.(*proto.Error).Code, proto.ErrBadRequest))
}

func TestRemoveRefusesABadPath(t *testing.T) {
	_, err := New(t.TempDir()).Remove("../today.json")

	assert.Check(t, cmp.Equal(err.(*proto.Error).Code, proto.ErrBadRequest))
}
