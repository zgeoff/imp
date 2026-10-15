//go:build root

// The tests that mount a tmpfs, so they need root: run them with -tags root as root.

package files

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/proto"
)

func TestWriteToAFullTreeAnswersNoSpaceAndLeavesNoStagedFile(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, unix.Mount("tmpfs", dir, "tmpfs", 0, "size=64k"))
	t.Cleanup(func() { unix.Unmount(dir, unix.MNT_DETACH) })

	err := New(dir).Write("big.json", make([]byte, 128<<10))

	assert.Check(t, cmp.ErrorType(err, &proto.Error{}))
	assert.Check(t, cmp.Equal(err.(*proto.Error).Code, proto.ErrNoSpace))
	entries, err := os.ReadDir(dir)
	assert.NilError(t, err)
	assert.Check(t, cmp.Len(entries, 0))
	_, statErr := os.Stat(filepath.Join(dir, "big.json"))
	assert.Check(t, os.IsNotExist(statErr))
}
