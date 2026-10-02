// Package cgroup gives each exec a cgroup v2 leaf of its own, so a stop can
// kill every process the command started, including the ones that left its
// process group, with cgroup.kill and no pid-reuse window.
package cgroup

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// poll is how often a leaf is checked for members.
const poll = 20 * time.Millisecond

// Tree hands out numbered leaves under one parent cgroup, which holds no
// process itself and enables no controller, so the "no internal processes"
// rule never applies. The parent is a parameter: tests point it at a plain
// directory, and an inner container points it at its own subtree.
type Tree struct {
	parent string

	mu   sync.Mutex
	next uint64
	// ended holds the leaves of sessions that are over but still had a
	// member (a nohup child, say) when they ended. Only these are swept:
	// a live session's leaf may be empty because its child is not yet
	// cloned into it.
	ended map[string]struct{}
}

// NewTree makes parent if needed and checks that leaves can be made in it.
func NewTree(parent string) (*Tree, error) {
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return nil, err
	}
	probe, err := os.MkdirTemp(parent, ".probe-")
	if err != nil {
		return nil, err
	}
	if err := os.Remove(probe); err != nil {
		return nil, err
	}
	return &Tree{parent: parent, ended: map[string]struct{}{}}, nil
}

// Group is one exec's leaf.
type Group struct {
	path string
	dir  *os.File
}

// New sweeps the ended leaves that have emptied, then makes and opens a new
// leaf.
func (t *Tree) New() (*Group, error) {
	t.mu.Lock()
	t.sweepLocked()
	t.next++
	path := filepath.Join(t.parent, strconv.FormatUint(t.next, 10))
	t.mu.Unlock()

	if err := os.Mkdir(path, 0o755); err != nil {
		return nil, err
	}
	dir, err := os.OpenFile(path, os.O_RDONLY|syscall.O_DIRECTORY, 0)
	if err != nil {
		os.Remove(path)
		return nil, err
	}
	return &Group{path: path, dir: dir}, nil
}

// Release ends g's session: its leaf goes now if it is empty, or at a later
// sweep once its last member exits.
func (t *Tree) Release(g *Group) {
	g.dir.Close()
	if err := os.Remove(g.path); err == nil || errors.Is(err, os.ErrNotExist) {
		return
	}
	t.mu.Lock()
	t.ended[g.path] = struct{}{}
	t.mu.Unlock()
}

// Ended returns how many ended leaves still wait for their last member.
func (t *Tree) Ended() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.ended)
}

func (t *Tree) sweepLocked() {
	for path := range t.ended {
		if err := os.Remove(path); err == nil || errors.Is(err, os.ErrNotExist) {
			delete(t.ended, path)
		}
	}
}

// Dir is the leaf's directory fd, for clone3's CLONE_INTO_CGROUP.
func (g *Group) Dir() *os.File { return g.dir }

// Kill SIGKILLs every process in the leaf and its descendants.
func (g *Group) Kill() error {
	return os.WriteFile(filepath.Join(g.path, "cgroup.kill"), []byte("1"), 0)
}

// WaitEmpty polls cgroup.events until it says "populated 0" or deadline
// passes, and reports whether the leaf emptied.
func (g *Group) WaitEmpty(deadline time.Time) bool {
	for {
		populated, err := g.populated()
		if err == nil && !populated {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(min(poll, time.Until(deadline)))
	}
}

func (g *Group) populated() (bool, error) {
	f, err := os.Open(filepath.Join(g.path, "cgroup.events"))
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if value, ok := strings.CutPrefix(sc.Text(), "populated "); ok {
			return value != "0", nil
		}
	}
	if err := sc.Err(); err != nil {
		return false, err
	}
	return false, fmt.Errorf("%s: no populated line", g.path)
}
