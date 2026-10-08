package services

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

// writeLog makes a log of size bytes that starts with head.
func writeLog(t *testing.T, path string, size int64, head string) {
	t.Helper()
	assert.NilError(t, os.WriteFile(path, []byte(head), 0o644))
	assert.NilError(t, os.Truncate(path, size))
}

func size(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	assert.NilError(t, err)
	return fi.Size()
}

func TestRotateLogLeavesALogAtTheCapInPlace(t *testing.T) {
	p := filepath.Join(t.TempDir(), "small.log")
	writeLog(t, p, maxLogSize, "s")

	err := rotateLog(fsroot.Host, p)

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(size(t, p), int64(maxLogSize)))
	_, statErr := os.Stat(p + ".1")
	assert.Check(t, cmp.ErrorIs(statErr, fs.ErrNotExist))
}

func TestRotateLogMovesALogOverTheCapOverTheOldBackup(t *testing.T) {
	p := filepath.Join(t.TempDir(), "big.log")
	writeLog(t, p, maxLogSize+1, "b")
	writeLog(t, p+".1", 1, "old")

	err := rotateLog(fsroot.Host, p)

	assert.NilError(t, err)
	_, statErr := os.Stat(p)
	assert.Check(t, cmp.ErrorIs(statErr, fs.ErrNotExist))
	assert.Check(t, cmp.Equal(size(t, p+".1"), int64(maxLogSize+1)))
}

func TestRotateLogIgnoresAMissingLog(t *testing.T) {
	err := rotateLog(fsroot.Host, filepath.Join(t.TempDir(), "missing.log"))

	assert.NilError(t, err)
}

// TestCopyTruncateLogLetsAnAppendingWriterGoOnAtTheNewEnd checks that a
// writer holding the log O_APPEND keeps writing to it after the copy,
// starting at the new end.
func TestCopyTruncateLogLetsAnAppendingWriterGoOnAtTheNewEnd(t *testing.T) {
	p := filepath.Join(t.TempDir(), "svc.log")
	writeLog(t, p, maxLogSize+1, "first")
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0o644)
	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })

	err = newSupervisor(t).copyTruncateLog(p)
	assert.NilError(t, err)
	_, err = f.WriteString("after\n")
	assert.NilError(t, err)

	assert.Check(t, cmp.Equal(size(t, p+".1"), int64(maxLogSize+1)), ".1 is not a full copy")
	b, err := os.ReadFile(p)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "after\n"))
	_, statErr := os.Stat(p + ".1.tmp")
	assert.Check(t, cmp.ErrorIs(statErr, fs.ErrNotExist), "temporary copy left behind")
}
