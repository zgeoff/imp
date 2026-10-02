package tartool

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// resolveBeneath keeps every lookup under the copy's parent and off
// symlinks: the extractor runs as root, and a guest process could swap a
// directory for a symlink between a check and a write. openat2 makes the
// check and the use one step.
const resolveBeneath = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS

// copyRoot is where the archive's top entry lands: base in the directory
// parent names.
type copyRoot struct {
	parent int
	base   string
	top    string
}

type pendingDir struct {
	rel     string
	mode    uint32
	modTime time.Time
}

type pendingSymlink struct {
	rel    string
	target string
}

type extractor struct {
	owner   *Owner
	warn    io.Writer
	root    *copyRoot
	dirs    []pendingDir
	links   []pendingSymlink
	created int
}

// Extract reads a tar from r into dest, as cp -r does: into dest/<top> when
// dest is a directory, else as dest. Every entry belongs to owner, or with a
// nil owner to the owner of the directory the copy lands in. In order:
//   - a name that is absolute, holds "..", or has another top is refused;
//   - no lookup follows a symlink below dest, so an entry under a symlink,
//     even one a guest process puts there meanwhile, is refused;
//   - a file is written to a fresh temp name, then renamed over its place;
//   - a hard link must point to a file of the copy;
//   - devices and FIFOs are skipped, and setuid and setgid are dropped;
//   - symlinks are made last, so no entry is written through one, and
//     directory modes after everything, so a read-only one can be filled.
//
// A refused entry is reported on warn and the rest still extract; the
// error then says so.
func Extract(dest string, r io.Reader, owner *Owner, warn io.Writer) error {
	x := &extractor{owner: owner, warn: warn}
	defer x.close()

	tr := tar.NewReader(r)
	refused := 0
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read the archive: %w", err)
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		if err := x.extractEntry(dest, hdr, tr); err != nil {
			if x.root == nil {
				return err
			}
			fmt.Fprintf(warn, "imp-agent tar: %s: %v\n", hdr.Name, err)
			refused++
		}
	}
	if x.root == nil {
		return errors.New("the archive is empty")
	}
	for _, link := range x.links {
		if err := x.makeSymlink(link); err != nil {
			fmt.Fprintf(warn, "imp-agent tar: %s: %v\n", link.rel, err)
			refused++
		}
	}
	x.finishDirs()
	if refused > 0 {
		return fmt.Errorf("%d entries were not copied", refused)
	}
	return nil
}

func (x *extractor) close() {
	if x.root != nil {
		unix.Close(x.root.parent)
	}
}

func (x *extractor) extractEntry(dest string, hdr *tar.Header, tr io.Reader) error {
	top, rest, err := splitName(hdr.Name)
	if err != nil {
		return err
	}
	if x.root == nil {
		if x.root, err = openCopyRoot(dest, top); err != nil {
			return err
		}
		if x.owner == nil {
			if x.owner, err = readOwner(x.root.parent); err != nil {
				return err
			}
		}
	} else if top != x.root.top {
		return fmt.Errorf("outside the copy's top %q", x.root.top)
	}
	rel := path.Join(x.root.base, rest)

	switch hdr.Typeflag {
	case tar.TypeDir:
		return x.makeDir(rel, hdr)
	case tar.TypeReg:
		return x.writeFile(rel, hdr, tr)
	case tar.TypeSymlink:
		x.links = append(x.links, pendingSymlink{rel: rel, target: hdr.Linkname})
		return nil
	case tar.TypeLink:
		return x.makeHardLink(rel, hdr.Linkname)
	default:
		fmt.Fprintf(x.warn, "imp-agent tar: %s: not a file, directory or link; skipped\n", hdr.Name)
		return nil
	}
}

// splitName is name's top component and the rest, or an error for a name
// that could leave the copy
func splitName(name string) (string, string, error) {
	if strings.HasPrefix(name, "/") {
		return "", "", errors.New("an absolute name")
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", "", errors.New(`a name with ".."`)
		}
	}
	clean := path.Clean(name)
	if clean == "." {
		return "", "", errors.New("an empty name")
	}
	top, rest, _ := strings.Cut(clean, "/")
	return top, rest, nil
}

// openCopyRoot opens the directory the top entry lands in. dest itself is
// the user's to name, so it may go through symlinks; nothing below it may.
func openCopyRoot(dest, top string) (*copyRoot, error) {
	parent, base := filepath.Dir(dest), filepath.Base(dest)
	if info, err := os.Stat(dest); err == nil && info.IsDir() {
		parent, base = dest, top
	}
	fd, err := unix.Open(parent, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", parent, err)
	}
	return &copyRoot{parent: fd, base: base, top: top}, nil
}

// readOwner is the owner of the directory fd names, so a copy into /etc
// belongs to root and one into /home/dev to dev
func readOwner(fd int) (*Owner, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, err
	}
	return &Owner{UID: int(st.Uid), GID: int(st.Gid)}, nil
}

// openParent opens rel's directory under the copy's parent, with flags
func (x *extractor) openParent(rel string, flags uint64) (int, string, error) {
	dir, base := path.Split(rel)
	if dir == "" {
		dir = "."
	}
	fd, err := openBeneath(x.root.parent, dir, flags|unix.O_DIRECTORY)
	if err != nil {
		return -1, "", err
	}
	return fd, base, nil
}

func openBeneath(dirfd int, rel string, flags uint64) (int, error) {
	fd, err := unix.Openat2(dirfd, rel, &unix.OpenHow{Flags: flags | unix.O_CLOEXEC, Resolve: resolveBeneath})
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.EXDEV) {
		return -1, fmt.Errorf("%s: under a symlink", rel)
	}
	if err != nil {
		return -1, fmt.Errorf("%s: %w", rel, err)
	}
	return fd, nil
}

func (x *extractor) makeDir(rel string, hdr *tar.Header) error {
	dirfd, base, err := x.openParent(rel, unix.O_PATH)
	if err != nil {
		return err
	}
	defer unix.Close(dirfd)
	err = unix.Mkdirat(dirfd, base, 0o700)
	if errors.Is(err, unix.EEXIST) {
		var st unix.Stat_t
		if err := unix.Fstatat(dirfd, base, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if st.Mode&unix.S_IFMT != unix.S_IFDIR {
			return errors.New("not a directory in the imp")
		}
		// a directory that was there keeps its owner and mode
		return nil
	}
	if err != nil {
		return err
	}
	if err := unix.Fchownat(dirfd, base, x.owner.UID, x.owner.GID, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	x.dirs = append(x.dirs, pendingDir{rel: rel, mode: uint32(hdr.Mode), modTime: hdr.ModTime})
	return nil
}

// tempName is unique within this extract; O_EXCL refuses one that exists
func (x *extractor) tempName() string {
	x.created++
	return fmt.Sprintf(".imp-cp-%d-%d", os.Getpid(), x.created)
}

func (x *extractor) writeFile(rel string, hdr *tar.Header, content io.Reader) error {
	dirfd, base, err := x.openParent(rel, unix.O_PATH)
	if err != nil {
		return err
	}
	defer unix.Close(dirfd)
	tmp := x.tempName()
	fd, err := unix.Openat(dirfd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), tmp)
	err = fillFile(f, hdr, content, x.owner)
	f.Close()
	if err == nil {
		err = unix.Renameat(dirfd, tmp, dirfd, base)
	}
	if err != nil {
		unix.Unlinkat(dirfd, tmp, 0)
		return err
	}
	return nil
}

func fillFile(f *os.File, hdr *tar.Header, content io.Reader, owner *Owner) error {
	if _, err := io.Copy(f, content); err != nil {
		return err
	}
	if err := f.Chown(owner.UID, owner.GID); err != nil {
		return err
	}
	// after the chown, which clears setuid; the mode drops it anyway
	if err := f.Chmod(safeMode(hdr.Mode)); err != nil {
		return err
	}
	return setTimes(int(f.Fd()), hdr.ModTime)
}

func setTimes(fd int, modTime time.Time) error {
	tv := unix.NsecToTimeval(modTime.UnixNano())
	return unix.Futimes(fd, []unix.Timeval{tv, tv})
}

// safeMode keeps the permission and sticky bits, not setuid or setgid
func safeMode(mode int64) os.FileMode {
	perm := os.FileMode(mode) & os.ModePerm
	if mode&0o1000 != 0 {
		perm |= os.ModeSticky
	}
	return perm
}

func (x *extractor) makeHardLink(rel, linkname string) error {
	top, rest, err := splitName(linkname)
	if err != nil || top != x.root.top {
		return fmt.Errorf("a hard link to %q, outside the copy", linkname)
	}
	oldfd, oldbase, err := x.openParent(path.Join(x.root.base, rest), unix.O_PATH)
	if err != nil {
		return err
	}
	defer unix.Close(oldfd)
	var st unix.Stat_t
	if err := unix.Fstatat(oldfd, oldbase, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("a hard link to %q: %w", linkname, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("a hard link to %q, not a file", linkname)
	}
	dirfd, base, err := x.openParent(rel, unix.O_PATH)
	if err != nil {
		return err
	}
	defer unix.Close(dirfd)
	return unix.Linkat(oldfd, oldbase, dirfd, base, 0)
}

func (x *extractor) makeSymlink(link pendingSymlink) error {
	dirfd, base, err := x.openParent(link.rel, unix.O_PATH)
	if err != nil {
		return err
	}
	defer unix.Close(dirfd)
	tmp := x.tempName()
	if err := unix.Symlinkat(link.target, dirfd, tmp); err != nil {
		return err
	}
	err = unix.Fchownat(dirfd, tmp, x.owner.UID, x.owner.GID, unix.AT_SYMLINK_NOFOLLOW)
	if err == nil {
		err = unix.Renameat(dirfd, tmp, dirfd, base)
	}
	if err != nil {
		unix.Unlinkat(dirfd, tmp, 0)
	}
	return err
}

// finishDirs sets the mode and time of each directory the copy made,
// deepest first, so a parent's time is not changed by a child's
func (x *extractor) finishDirs() {
	sort.Slice(x.dirs, func(i, j int) bool {
		return strings.Count(x.dirs[i].rel, "/") > strings.Count(x.dirs[j].rel, "/")
	})
	for _, dir := range x.dirs {
		fd, err := openBeneath(x.root.parent, dir.rel, unix.O_RDONLY|unix.O_DIRECTORY)
		if err != nil {
			fmt.Fprintf(x.warn, "imp-agent tar: %s: %v\n", dir.rel, err)
			continue
		}
		f := os.NewFile(uintptr(fd), dir.rel)
		if err := f.Chmod(safeMode(int64(dir.mode))); err != nil {
			fmt.Fprintf(x.warn, "imp-agent tar: %s: %v\n", dir.rel, err)
		}
		if err := setTimes(fd, dir.modTime); err != nil {
			fmt.Fprintf(x.warn, "imp-agent tar: %s: %v\n", dir.rel, err)
		}
		f.Close()
	}
}
