package cgroup

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// These run on plain directories: what cgroupfs adds (cgroup.kill, a leaf
// that rmdir takes with its files) is left to the e2e suite.

func TestNewTreeRefusesAnUnwritableParent(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if _, err := NewTree(filepath.Join(dir, "imp-exec")); err == nil {
		t.Fatal("NewTree made a tree it cannot write")
	}
}

func TestReleaseRemovesAnEmptyLeaf(t *testing.T) {
	tree, err := NewTree(filepath.Join(t.TempDir(), "imp-exec"))
	if err != nil {
		t.Fatal(err)
	}
	g, err := tree.New()
	if err != nil {
		t.Fatal(err)
	}
	if g.Dir() == nil {
		t.Fatal("no directory fd")
	}
	tree.Release(g)
	if _, err := os.Stat(g.path); !os.IsNotExist(err) {
		t.Fatalf("leaf %s left after release: %v", g.path, err)
	}
	if tree.Ended() != 0 {
		t.Fatal("an empty leaf waits for a sweep")
	}
}

// TestSweepSparesLiveLeaves: an ended leaf with a member waits until it
// empties; a live session's leaf is never swept, even while it is empty.
func TestSweepSparesLiveLeaves(t *testing.T) {
	tree, err := NewTree(filepath.Join(t.TempDir(), "imp-exec"))
	if err != nil {
		t.Fatal(err)
	}
	ended, err := tree.New()
	if err != nil {
		t.Fatal(err)
	}
	// a nohup child still in the leaf; on a plain directory, a file
	member := filepath.Join(ended.path, "member")
	if err := os.WriteFile(member, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	tree.Release(ended)
	if tree.Ended() != 1 {
		t.Fatalf("ended = %d, want the busy leaf kept", tree.Ended())
	}

	live, err := tree.New()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ended.path); err != nil {
		t.Fatal("a sweep took a leaf that still has a member")
	}

	os.Remove(member)
	next, err := tree.New()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ended.path); !os.IsNotExist(err) {
		t.Fatal("the emptied leaf outlived the sweep")
	}
	if _, err := os.Stat(live.path); err != nil {
		t.Fatal("the sweep took a live session's empty leaf")
	}
	tree.Release(live)
	tree.Release(next)
}

func TestWaitEmptyReadsPopulated(t *testing.T) {
	tree, err := NewTree(filepath.Join(t.TempDir(), "imp-exec"))
	if err != nil {
		t.Fatal(err)
	}
	g, err := tree.New()
	if err != nil {
		t.Fatal(err)
	}
	events := filepath.Join(g.path, "cgroup.events")
	if err := os.WriteFile(events, []byte("populated 1\nfrozen 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if g.WaitEmpty(time.Now().Add(50 * time.Millisecond)) {
		t.Fatal("a populated leaf counted as empty")
	}
	go func() {
		time.Sleep(30 * time.Millisecond)
		os.WriteFile(events, []byte("populated 0\nfrozen 0\n"), 0o600)
	}()
	if !g.WaitEmpty(time.Now().Add(5 * time.Second)) {
		t.Fatal("the leaf never emptied")
	}
}

// TestLimitedTreeSetsItsLimitsAgain: a parent removed under the tree is made
// again with its limits, and a leaf whose limits cannot be set is not made.
func TestLimitedTreeSetsItsLimitsAgain(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "outer")
	var failing bool
	prepare := func(dir string) error {
		if failing {
			return os.ErrPermission
		}
		return os.WriteFile(filepath.Join(dir, "memory.max"), []byte("33554432"), 0o644)
	}
	tree, err := NewLimitedTree(parent, prepare)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(parent); err != nil {
		t.Fatal(err)
	}
	g, err := tree.New()
	if err != nil {
		t.Fatal(err)
	}
	tree.Release(g)
	if b, err := os.ReadFile(filepath.Join(parent, "memory.max")); err != nil || string(b) != "33554432" {
		t.Fatalf("memory.max = %q (%v), want the limit again", b, err)
	}
	failing = true
	if _, err := tree.New(); err == nil {
		t.Fatal("made a leaf whose limits could not be set")
	}
}
