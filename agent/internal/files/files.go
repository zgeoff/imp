// Package files keeps the read-only files: a tree that impd writes through
// the agent and the inner container sees on a read-only bind, so a process
// inside, root included, gets EROFS on every write
// (docs/architecture/guest/agent.md#read-only-files).
package files

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"regexp"
	"strings"
	"syscall"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/proto"
)

const (
	// Dir is the tree in the agent's world, a tmpfs of its own.
	Dir = "/run/files"
	// Size caps that tmpfs.
	Size = "16m"

	// MaxData caps one file's content, which must fit a frame as base64.
	MaxData = 512 << 10

	maxSegments = 8
	maxPath     = 512
)

// SegmentRule is one segment of a path. A segment never starts with a dot,
// so no path names a staged file. impd checks the same rule.
var SegmentRule = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

// Store writes and removes files under one directory.
type Store struct {
	dir string
}

// New keeps the files under dir.
func New(dir string) *Store {
	return &Store{dir: dir}
}

// Write replaces the file at p with data, mode 0444, through a rename, so a
// reader sees the old content or the new and never part of either.
func (s *Store) Write(p string, data []byte) error {
	if err := checkPath(p); err != nil {
		return err
	}
	if len(data) > MaxData {
		return badRequest("data is %d bytes, over the %d byte cap", len(data), MaxData)
	}
	root, err := fsroot.Open(s.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	dir, name := path.Split("/" + p)
	if dir != "/" {
		if err := root.MkdirAll(strings.TrimSuffix(dir, "/"), 0o755); err != nil {
			return mapErr(err)
		}
	}
	if fi, err := root.Lstat("/" + p); err == nil && !fi.Mode().IsRegular() {
		return badRequest("%s is not a regular file", p)
	}
	staged, err := stagedName(dir, name)
	if err != nil {
		return err
	}
	if err := writeStaged(root, staged, data); err != nil {
		_ = root.Remove(staged)
		return mapErr(err)
	}
	if err := root.Rename(staged, "/"+p); err != nil {
		_ = root.Remove(staged)
		return mapErr(err)
	}
	return nil
}

// Remove removes the file at p, and reports whether there was one.
func (s *Store) Remove(p string) (bool, error) {
	if err := checkPath(p); err != nil {
		return false, err
	}
	root, err := fsroot.Open(s.dir)
	if err != nil {
		return false, err
	}
	defer root.Close()
	fi, err := root.Lstat("/" + p)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !fi.Mode().IsRegular() {
		return false, badRequest("%s is not a regular file", p)
	}
	// a remove beside this one may take the file first
	err = root.Remove("/" + p)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// checkPath refuses a path outside the rule impd holds it to as well.
func checkPath(p string) error {
	if p == "" || len(p) > maxPath {
		return badRequest("path must be 1 to %d bytes", maxPath)
	}
	parts := strings.Split(p, "/")
	if len(parts) > maxSegments {
		return badRequest("path has more than %d segments", maxSegments)
	}
	for _, part := range parts {
		if !SegmentRule.MatchString(part) {
			return badRequest("path segment %q is not allowed", part)
		}
	}
	return nil
}

func stagedName(dir, name string) (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return dir + "." + name + "." + hex.EncodeToString(b), nil
}

func writeStaged(root *fsroot.Root, staged string, data []byte) error {
	f, err := root.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o444)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	// past the umask
	if err := f.Chmod(0o444); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// mapErr turns a full tmpfs into NO_SPACE and a path through a file into
// BAD_REQUEST; anything else stays as it is.
func mapErr(err error) error {
	switch {
	case errors.Is(err, syscall.ENOSPC):
		return &proto.Error{Code: proto.ErrNoSpace, Message: fmt.Sprintf("the read-only files are full (%s): %v", Size, err)}
	case errors.Is(err, syscall.ENOTDIR), errors.Is(err, syscall.EISDIR), errors.Is(err, fs.ErrExist):
		return badRequest("%v", err)
	}
	return err
}

func badRequest(format string, args ...any) error {
	return &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf(format, args...)}
}
