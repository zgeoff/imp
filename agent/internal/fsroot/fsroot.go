// Package fsroot gives the agent the user's files without leaving the user's
// root. The agent lives outside the inner container; a path it opens inside
// resolves with openat2(RESOLVE_IN_ROOT) on a dirfd of the inner root, so a
// symlink the user planted (/etc/hosts -> /proc/1/root/...) stays inside.
// Host is the plain filesystem, for the inner container itself and tests.
package fsroot

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// FS is the set of file operations the agent does on user files. Paths are
// absolute, as the user sees them.
type FS interface {
	OpenFile(path string, flag int, perm os.FileMode) (*os.File, error)
	ReadFile(path string) ([]byte, error)
	ReadDir(path string) ([]fs.DirEntry, error)
	Stat(path string) (fs.FileInfo, error)
	Lstat(path string) (fs.FileInfo, error)
	MkdirAll(path string, perm os.FileMode) error
	Rename(oldpath, newpath string) error
	Remove(path string) error
	RemoveAll(path string) error
	Truncate(path string, size int64) error
	Lchown(path string, uid, gid int) error
	Chmod(path string, mode os.FileMode) error
	// Dir opens a directory for *at calls and socket paths (/proc/self/fd/N).
	Dir(path string) (*os.File, error)
}

// Host is the filesystem as this process sees it.
var Host FS = hostFS{}

type hostFS struct{}

func (hostFS) OpenFile(p string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(p, flag, perm)
}
func (hostFS) ReadFile(p string) ([]byte, error)         { return os.ReadFile(p) }
func (hostFS) ReadDir(p string) ([]fs.DirEntry, error)   { return os.ReadDir(p) }
func (hostFS) Stat(p string) (fs.FileInfo, error)        { return os.Stat(p) }
func (hostFS) Lstat(p string) (fs.FileInfo, error)       { return os.Lstat(p) }
func (hostFS) MkdirAll(p string, perm os.FileMode) error { return os.MkdirAll(p, perm) }
func (hostFS) Rename(o, n string) error                  { return os.Rename(o, n) }
func (hostFS) Remove(p string) error                     { return os.Remove(p) }
func (hostFS) RemoveAll(p string) error                  { return os.RemoveAll(p) }
func (hostFS) Truncate(p string, size int64) error       { return os.Truncate(p, size) }
func (hostFS) Lchown(p string, uid, gid int) error       { return os.Lchown(p, uid, gid) }
func (hostFS) Chmod(p string, mode os.FileMode) error    { return os.Chmod(p, mode) }
func (hostFS) Dir(p string) (*os.File, error)            { return os.Open(p) }

// Root is a directory that every path resolves inside.
type Root struct {
	dir *os.File
}

// resolve keeps every lookup inside the root: ".." stops at it, an absolute
// symlink starts from it, and /proc magic links are refused.
const resolve = unix.RESOLVE_IN_ROOT | unix.RESOLVE_NO_MAGICLINKS

// Open opens dir (such as /proc/<pid>/root) as a root.
func Open(dir string) (*Root, error) {
	f, err := os.OpenFile(dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return &Root{dir: f}, nil
}

func (r *Root) Close() error { return r.dir.Close() }

func rel(p string) string {
	p = strings.TrimLeft(filepath.Clean("/"+p), "/")
	if p == "" {
		return "."
	}
	return p
}

func pathErr(op, p string, err error) error {
	if err == nil {
		return nil
	}
	return &fs.PathError{Op: op, Path: p, Err: err}
}

func (r *Root) openat2(p string, flag int, perm os.FileMode) (int, error) {
	for {
		fd, err := unix.Openat2(int(r.dir.Fd()), rel(p), &unix.OpenHow{
			Flags:   uint64(flag | unix.O_CLOEXEC),
			Mode:    uint64(perm.Perm()),
			Resolve: resolve,
		})
		// openat2 answers EAGAIN when a rename raced the lookup
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		return fd, err
	}
}

func (r *Root) OpenFile(p string, flag int, perm os.FileMode) (*os.File, error) {
	fd, err := r.openat2(p, flag, perm)
	if err != nil {
		return nil, pathErr("open", p, err)
	}
	return os.NewFile(uintptr(fd), p), nil
}

// parent opens p's directory and returns it with p's last name. The last
// name is never followed by the *at calls that use it.
func (r *Root) parent(p string) (*os.File, string, error) {
	clean := rel(p)
	if clean == "." {
		return nil, "", fmt.Errorf("%s: the root has no parent", p)
	}
	dir, err := r.OpenFile(filepath.Dir("/"+clean), unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, "", err
	}
	return dir, filepath.Base(clean), nil
}

// ReadFile reads a regular file. O_NONBLOCK and the check keep a FIFO or a
// device the user put at p from blocking the agent.
func (r *Root) ReadFile(p string) ([]byte, error) {
	f, err := r.OpenFile(p, os.O_RDONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err := CheckRegular(f, p); err != nil {
		return nil, err
	}
	return io.ReadAll(f)
}

// ErrNotRegular is a read of something other than a regular file.
var ErrNotRegular = errors.New("not a regular file")

// CheckRegular fails unless f, opened at p, is a regular file.
func CheckRegular(f *os.File, p string) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return &fs.PathError{Op: "read", Path: p, Err: ErrNotRegular}
	}
	return nil
}

func (r *Root) ReadDir(p string) ([]fs.DirEntry, error) {
	f, err := r.OpenFile(p, os.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.ReadDir(-1)
}

func (r *Root) Stat(p string) (fs.FileInfo, error) {
	f, err := r.OpenFile(p, unix.O_PATH, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return statFd(int(f.Fd()), "", unix.AT_EMPTY_PATH, p)
}

func (r *Root) Lstat(p string) (fs.FileInfo, error) {
	if rel(p) == "." {
		return r.Stat(p)
	}
	dir, name, err := r.parent(p)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	return statFd(int(dir.Fd()), name, unix.AT_SYMLINK_NOFOLLOW, p)
}

func (r *Root) MkdirAll(p string, perm os.FileMode) error {
	clean := rel(p)
	if clean == "." {
		return nil
	}
	cur := ""
	for _, name := range strings.Split(clean, "/") {
		cur += "/" + name
		dir, base, err := r.parent(cur)
		if err != nil {
			return err
		}
		err = unix.Mkdirat(int(dir.Fd()), base, uint32(perm.Perm()))
		dir.Close()
		if err != nil && !errors.Is(err, unix.EEXIST) {
			return pathErr("mkdir", cur, err)
		}
		// an existing name must be a directory, reached inside the root
		if fi, err := r.Stat(cur); err != nil {
			return err
		} else if !fi.IsDir() {
			return pathErr("mkdir", cur, unix.ENOTDIR)
		}
	}
	return nil
}

func (r *Root) Rename(oldpath, newpath string) error {
	od, oname, err := r.parent(oldpath)
	if err != nil {
		return err
	}
	defer od.Close()
	nd, nname, err := r.parent(newpath)
	if err != nil {
		return err
	}
	defer nd.Close()
	return pathErr("rename", oldpath, unix.Renameat(int(od.Fd()), oname, int(nd.Fd()), nname))
}

func (r *Root) Remove(p string) error {
	dir, name, err := r.parent(p)
	if err != nil {
		return err
	}
	defer dir.Close()
	err = unix.Unlinkat(int(dir.Fd()), name, 0)
	if errors.Is(err, unix.EISDIR) {
		err = unix.Unlinkat(int(dir.Fd()), name, unix.AT_REMOVEDIR)
	}
	return pathErr("remove", p, err)
}

func (r *Root) RemoveAll(p string) error {
	fi, err := r.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.IsDir() {
		ents, err := r.ReadDir(p)
		if err != nil {
			return err
		}
		for _, e := range ents {
			if err := r.RemoveAll(filepath.Join(p, e.Name())); err != nil {
				return err
			}
		}
	}
	return r.Remove(p)
}

func (r *Root) Truncate(p string, size int64) error {
	f, err := r.OpenFile(p, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Truncate(size)
}

func (r *Root) Lchown(p string, uid, gid int) error {
	dir, name, err := r.parent(p)
	if err != nil {
		return err
	}
	defer dir.Close()
	return pathErr("lchown", p, unix.Fchownat(int(dir.Fd()), name, uid, gid, unix.AT_SYMLINK_NOFOLLOW))
}

func (r *Root) Chmod(p string, mode os.FileMode) error {
	f, err := r.OpenFile(p, unix.O_PATH, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	// fchmod does not take an O_PATH fd; its /proc/self/fd link does
	return pathErr("chmod", p, unix.Chmod(fmt.Sprintf("/proc/self/fd/%d", f.Fd()), uint32(mode.Perm())))
}

func (r *Root) Dir(p string) (*os.File, error) {
	return r.OpenFile(p, unix.O_PATH|unix.O_DIRECTORY, 0)
}

type fileInfo struct {
	name string
	st   unix.Stat_t
}

func statFd(dirfd int, name string, flags int, p string) (fs.FileInfo, error) {
	var st unix.Stat_t
	if err := unix.Fstatat(dirfd, name, &st, flags); err != nil {
		return nil, pathErr("stat", p, err)
	}
	return &fileInfo{name: filepath.Base(p), st: st}, nil
}

func (f *fileInfo) Name() string       { return f.name }
func (f *fileInfo) Size() int64        { return f.st.Size }
func (f *fileInfo) ModTime() time.Time { return time.Unix(f.st.Mtim.Unix()) }
func (f *fileInfo) IsDir() bool        { return f.Mode().IsDir() }

// Sys is a *syscall.Stat_t, as os.Stat's is: callers type-assert it.
// unix.Stat_t has the same layout.
func (f *fileInfo) Sys() any { return (*syscall.Stat_t)(unsafe.Pointer(&f.st)) }

func (f *fileInfo) Mode() fs.FileMode {
	m := fs.FileMode(f.st.Mode & 0o777)
	switch f.st.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		m |= fs.ModeDir
	case unix.S_IFLNK:
		m |= fs.ModeSymlink
	case unix.S_IFIFO:
		m |= fs.ModeNamedPipe
	case unix.S_IFSOCK:
		m |= fs.ModeSocket
	case unix.S_IFCHR:
		m |= fs.ModeDevice | fs.ModeCharDevice
	case unix.S_IFBLK:
		m |= fs.ModeDevice
	}
	if f.st.Mode&unix.S_ISUID != 0 {
		m |= fs.ModeSetuid
	}
	if f.st.Mode&unix.S_ISGID != 0 {
		m |= fs.ModeSetgid
	}
	if f.st.Mode&unix.S_ISVTX != 0 {
		m |= fs.ModeSticky
	}
	return m
}

// WriteFileAtomic replaces p through a temporary file and a rename in fsys,
// so a crash mid-write cannot leave it truncated.
func WriteFileAtomic(fsys FS, p string, data []byte, mode os.FileMode) error {
	tmp := filepath.Join(filepath.Dir(p), fmt.Sprintf(".%s.%d", filepath.Base(p), time.Now().UnixNano()))
	f, err := fsys.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = fsys.Rename(tmp, p)
	}
	if err != nil {
		fsys.Remove(tmp)
	}
	return err
}
