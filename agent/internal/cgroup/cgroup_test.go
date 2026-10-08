package cgroup

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

// These run on plain directories: what cgroupfs adds (cgroup.kill, a leaf
// that rmdir takes with its files) is left to the e2e suite.

// newTree makes a tree under a fresh temporary parent.
func newTree(t *testing.T) *Tree {
	t.Helper()
	tree, err := NewTree(filepath.Join(t.TempDir(), "imp-exec"))
	assert.NilError(t, err)
	return tree
}

// newLeaf makes a leaf of tree that the test's cleanup releases.
func newLeaf(t *testing.T, tree *Tree) *Group {
	t.Helper()
	g, err := tree.New()
	assert.NilError(t, err)
	t.Cleanup(func() { tree.Release(g) })
	return g
}

// endedBusyLeaf makes a leaf, puts a member in it (on a plain directory, a
// file standing for a nohup child), and releases it. It returns the leaf's
// path and the member's.
func endedBusyLeaf(t *testing.T, tree *Tree) (leaf, member string) {
	t.Helper()
	g, err := tree.New()
	assert.NilError(t, err)
	member = filepath.Join(g.path, "member")
	assert.NilError(t, os.WriteFile(member, nil, 0o600))
	tree.Release(g)
	return g.path, member
}

func TestNewTreeRefusesAnUnwritableParent(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	dir := t.TempDir()
	assert.NilError(t, os.Chmod(dir, 0o500))
	t.Cleanup(func() { os.Chmod(dir, 0o700) })

	_, err := NewTree(filepath.Join(dir, "imp-exec"))

	assert.ErrorIs(t, err, fs.ErrPermission)
}

func TestNewOpensTheLeafDirectory(t *testing.T) {
	tree := newTree(t)

	g := newLeaf(t, tree)

	fi, err := g.Dir().Stat()
	assert.NilError(t, err)
	assert.Check(t, fi.IsDir())
	assert.Check(t, cmp.Equal(fi.Name(), "1"))
}

func TestReleaseRemovesAnEmptyLeaf(t *testing.T) {
	tree := newTree(t)
	g, err := tree.New()
	assert.NilError(t, err)

	tree.Release(g)

	_, err = os.Stat(g.path)
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist), "leaf %s left after release", g.path)
	assert.Check(t, cmp.Equal(tree.Ended(), 0), "an empty leaf waits for a sweep")
}

func TestReleaseKeepsALeafThatStillHasAMember(t *testing.T) {
	tree := newTree(t)

	leaf, _ := endedBusyLeaf(t, tree)

	_, err := os.Stat(leaf)
	assert.Check(t, err)
	assert.Check(t, cmp.Equal(tree.Ended(), 1))
}

func TestNewSparesAnEndedLeafThatStillHasAMember(t *testing.T) {
	tree := newTree(t)
	leaf, _ := endedBusyLeaf(t, tree)

	newLeaf(t, tree)

	_, err := os.Stat(leaf)
	assert.Check(t, err, "a sweep took a leaf that still has a member")
	assert.Check(t, cmp.Equal(tree.Ended(), 1))
}

func TestNewSweepsAnEndedLeafOnceItEmpties(t *testing.T) {
	tree := newTree(t)
	leaf, member := endedBusyLeaf(t, tree)
	assert.NilError(t, os.Remove(member))

	newLeaf(t, tree)

	_, err := os.Stat(leaf)
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist), "the emptied leaf outlived the sweep")
	assert.Check(t, cmp.Equal(tree.Ended(), 0))
}

// A live session's leaf may be empty because its child is not yet cloned
// into it, so a sweep never takes it.
func TestNewNeverSweepsALiveSessionsEmptyLeaf(t *testing.T) {
	tree := newTree(t)
	_, member := endedBusyLeaf(t, tree)
	live := newLeaf(t, tree)
	assert.NilError(t, os.Remove(member))

	newLeaf(t, tree)

	_, err := os.Stat(live.path)
	assert.Check(t, err, "the sweep took a live session's empty leaf")
}

func TestKillFailsOnALeafWithoutCgroupKill(t *testing.T) {
	g := newLeaf(t, newTree(t))

	err := g.Kill()

	assert.ErrorIs(t, err, fs.ErrNotExist)
}

func TestWaitEmptyReportsAPopulatedLeafAtTheDeadline(t *testing.T) {
	g := newLeaf(t, newTree(t))
	events := filepath.Join(g.path, "cgroup.events")
	assert.NilError(t, os.WriteFile(events, []byte("populated 1\nfrozen 0\n"), 0o600))

	empty := g.WaitEmpty(time.Now().Add(50 * time.Millisecond))

	assert.Check(t, !empty, "a populated leaf counted as empty")
}

func TestWaitEmptyReturnsOnceTheLeafEmpties(t *testing.T) {
	g := newLeaf(t, newTree(t))
	events := filepath.Join(g.path, "cgroup.events")
	assert.NilError(t, os.WriteFile(events, []byte("populated 1\nfrozen 0\n"), 0o600))
	// the first read must see the leaf populated before it empties
	reads := make(chan bool, 1)
	waitEmptyRead = func(populated bool, err error) {
		if err != nil {
			return
		}
		select {
		case reads <- populated:
		default:
		}
	}
	t.Cleanup(func() { waitEmptyRead = nil })
	emptied := make(chan bool, 1)
	go func() { emptied <- g.WaitEmpty(time.Now().Add(5 * time.Second)) }()
	var first bool
	select {
	case first = <-reads:
	case <-time.After(5 * time.Second):
		t.Fatal("WaitEmpty never read cgroup.events")
	}

	assert.NilError(t, os.WriteFile(events, []byte("populated 0\nfrozen 0\n"), 0o600))

	assert.Check(t, first, "the first read saw the leaf empty")
	assert.Check(t, <-emptied, "the leaf never emptied")
}

// A parent removed under the tree is made again with its limits.
func TestLimitedTreeSetsItsLimitsAgainOnARemovedParent(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "outer")
	tree, err := NewLimitedTree(parent, func(dir string) error {
		return os.WriteFile(filepath.Join(dir, "memory.max"), []byte("33554432"), 0o644)
	})
	assert.NilError(t, err)
	assert.NilError(t, os.RemoveAll(parent))

	newLeaf(t, tree)

	b, err := os.ReadFile(filepath.Join(parent, "memory.max"))
	assert.NilError(t, err)
	assert.Equal(t, string(b), "33554432")
}

func TestLimitedTreeMakesNoLeafWhoseLimitsCannotBeSet(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "outer")
	failing := false
	tree, err := NewLimitedTree(parent, func(string) error {
		if failing {
			return os.ErrPermission
		}
		return nil
	})
	assert.NilError(t, err)
	failing = true

	g, err := tree.New()

	assert.Check(t, cmp.ErrorIs(err, os.ErrPermission))
	assert.Check(t, cmp.Nil(g))
	_, err = os.Stat(filepath.Join(parent, "1"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist), "made the leaf anyway")
}

func TestNewLimitedTreeFailsWhenItsLimitsCannotBeSet(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "outer")

	tree, err := NewLimitedTree(parent, func(string) error { return os.ErrPermission })

	assert.Check(t, cmp.ErrorIs(err, os.ErrPermission))
	assert.Check(t, cmp.Nil(tree))
}
