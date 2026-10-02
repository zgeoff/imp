package tartool

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// Create writes path to w as a tar: one top entry named after path's base,
// and for a directory everything below it. Directories, regular files and
// symlinks go in, with their modes and times; a symlink is not followed.
// Sockets, devices and FIFOs are left out, with a line on warn. A sparse
// file goes in whole, its holes as zeros.
func Create(path string, w io.Writer, warn io.Writer) error {
	top := filepath.Base(path)
	if top == "/" || top == "." {
		return fmt.Errorf("%s: name a file or directory below /", path)
	}
	if _, err := os.Lstat(path); err != nil {
		return err
	}
	total := countBytes(path)

	tw := tar.NewWriter(w)
	first := true
	err := filepath.WalkDir(path, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			if p == path {
				return err
			}
			fmt.Fprintf(warn, "imp-agent tar: %v\n", err)
			return nil
		}
		name := top
		if p != path {
			rel, _ := filepath.Rel(path, p)
			name = top + "/" + filepath.ToSlash(rel)
		}
		hdr, err := buildHeader(p, name)
		if err != nil {
			fmt.Fprintf(warn, "imp-agent tar: %v\n", err)
			return nil
		}
		if hdr == nil {
			fmt.Fprintf(warn, "imp-agent tar: %s: not a file, directory or symlink; left out\n", p)
			return nil
		}
		if first {
			hdr.PAXRecords = map[string]string{TotalRecord: strconv.FormatInt(total, 10)}
			first = false
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if hdr.Typeflag == tar.TypeReg {
			return writeContent(tw, p, hdr.Size)
		}
		return nil
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

// countBytes is the size of every regular file under path, for progress
func countBytes(path string) int64 {
	var total int64
	filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

// buildHeader is p's header under name, or nil for a type a copy leaves out
func buildHeader(p, name string) (*tar.Header, error) {
	info, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	link := ""
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		if link, err = os.Readlink(p); err != nil {
			return nil, err
		}
	case info.IsDir(), info.Mode().IsRegular():
	default:
		return nil, nil
	}
	hdr, err := tar.FileInfoHeader(info, link)
	if err != nil {
		return nil, err
	}
	hdr.Name = name
	if info.IsDir() {
		hdr.Name += "/"
	}
	// the laptop's own user owns what it extracts; names would only leak
	hdr.Uname, hdr.Gname = "", ""
	hdr.Format = tar.FormatPAX
	return hdr, nil
}

// writeContent copies exactly size bytes of p: a file that shrank since
// its header was written is an error, not a short archive
func writeContent(w io.Writer, p string, size int64) error {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := io.CopyN(w, f, size)
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("%s: shrank to %d bytes while it was copied", p, n)
	}
	return err
}
