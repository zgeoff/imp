package tartool

import (
	"archive/tar"
	"bytes"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func ownOwner() *Owner {
	return &Owner{UID: os.Getuid(), GID: os.Getgid()}
}

// buildArchive writes entries to a tar; a TypeReg entry's Linkname is its
// content
func buildArchive(t *testing.T, entries ...tar.Header) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, hdr := range entries {
		content := ""
		if hdr.Typeflag == tar.TypeReg {
			content, hdr.Linkname = hdr.Linkname, ""
			hdr.Size = int64(len(content))
		}
		if hdr.Mode == 0 {
			hdr.Mode = 0o644
		}
		assert.NilError(t, tw.WriteHeader(&hdr))
		_, err := io.WriteString(tw, content)
		assert.NilError(t, err)
	}
	assert.NilError(t, tw.Close())
	return &buf
}

func dirEntry(name string) tar.Header {
	return tar.Header{Typeflag: tar.TypeDir, Name: name, Mode: 0o755}
}

func fileEntry(name, content string) tar.Header {
	return tar.Header{Typeflag: tar.TypeReg, Name: name, Linkname: content}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	return string(b)
}

func TestBuildArchiveWritesARegularFilesLinknameAsItsContent(t *testing.T) {
	archive := buildArchive(t, fileEntry("src/a", "hello"))
	tr := tar.NewReader(archive)

	hdr, err := tr.Next()

	assert.NilError(t, err)
	content, err := io.ReadAll(tr)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(hdr.Name, "src/a"))
	assert.Check(t, cmp.Equal(hdr.Linkname, ""))
	assert.Check(t, cmp.Equal(hdr.Mode, int64(0o644)))
	assert.Check(t, cmp.Equal(string(content), "hello"))
}

// makeProject makes proj/ with an executable under bin/ stamped at stamp, a
// private file whose name has spaces, and a relative symlink.
func makeProject(t *testing.T, stamp time.Time) string {
	t.Helper()
	src := filepath.Join(t.TempDir(), "proj")
	assert.NilError(t, os.MkdirAll(filepath.Join(src, "bin"), 0o750))
	assert.NilError(t, os.WriteFile(filepath.Join(src, "bin", "run"), []byte("#!/bin/sh\n"), 0o755))
	assert.NilError(t, os.WriteFile(filepath.Join(src, "notes with spaces.txt"), []byte("hello"), 0o600))
	assert.NilError(t, os.Symlink("bin/run", filepath.Join(src, "link")))
	assert.NilError(t, os.Chtimes(filepath.Join(src, "bin", "run"), stamp, stamp))
	// whatever the umask left
	assert.NilError(t, os.Chmod(filepath.Join(src, "bin"), 0o750))
	assert.NilError(t, os.Chmod(filepath.Join(src, "bin", "run"), 0o755))
	return src
}

func TestCreatePutsTheTotalBytesOnTheTopEntry(t *testing.T) {
	src := makeProject(t, time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC))
	var archive, warn bytes.Buffer

	err := Create(src, &archive, &warn)

	assert.NilError(t, err)
	first, err := tar.NewReader(&archive).Next()
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(first.Name, "proj/"))
	assert.Check(t, cmp.Equal(first.PAXRecords[TotalRecord], "15"))
}

func TestARoundTripKeepsModesTimesAndSymlinks(t *testing.T) {
	stamp := time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC)
	src := makeProject(t, stamp)
	var archive, warn bytes.Buffer
	assert.NilError(t, Create(src, &archive, &warn))
	dest := t.TempDir()

	err := Extract(dest, &archive, ownOwner(), &warn)

	assert.NilError(t, err, warn.String())
	out := filepath.Join(dest, "proj")
	run, err := os.Stat(filepath.Join(out, "bin", "run"))
	assert.NilError(t, err)
	bin, err := os.Stat(filepath.Join(out, "bin"))
	assert.NilError(t, err)
	notes, err := os.Stat(filepath.Join(out, "notes with spaces.txt"))
	assert.NilError(t, err)
	link, err := os.Readlink(filepath.Join(out, "link"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(run.Mode().Perm(), fs.FileMode(0o755)))
	assert.Check(t, cmp.Equal(bin.Mode().Perm(), fs.FileMode(0o750)))
	assert.Check(t, cmp.Equal(notes.Mode().Perm(), fs.FileMode(0o600)))
	assert.Check(t, run.ModTime().Equal(stamp), "mtime %v, want %v", run.ModTime(), stamp)
	assert.Check(t, cmp.Equal(link, "bin/run"))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(out, "notes with spaces.txt")), "hello"))
}

func TestCreateRefusesTheRoot(t *testing.T) {
	var archive, warn bytes.Buffer

	err := Create("/", &archive, &warn)

	assert.ErrorContains(t, err, "name a file or directory below /")
}

func TestCreateFailsForAMissingPath(t *testing.T) {
	var archive, warn bytes.Buffer

	err := Create(filepath.Join(t.TempDir(), "missing"), &archive, &warn)

	assert.ErrorIs(t, err, fs.ErrNotExist)
}

func TestCreateLeavesOutAFIFOWithAWarning(t *testing.T) {
	src := filepath.Join(t.TempDir(), "proj")
	assert.NilError(t, os.Mkdir(src, 0o755))
	assert.NilError(t, unix.Mkfifo(filepath.Join(src, "fifo"), 0o644))
	var archive, warn bytes.Buffer

	err := Create(src, &archive, &warn)

	assert.NilError(t, err)
	var names []string
	tr := tar.NewReader(&archive)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		assert.NilError(t, err)
		names = append(names, hdr.Name)
	}
	assert.Check(t, cmp.DeepEqual(names, []string{"proj/"}))
	assert.Check(t, cmp.Contains(warn.String(), "fifo: not a file, directory or symlink; left out"))
}

// As cp -r: into dest/<top> when dest is a directory, else as dest
func TestExtractPutsTheTopInAnExistingDirectoryOrNamesItDest(t *testing.T) {
	for _, tc := range []struct {
		name string
		dest string // under a fresh directory
		want string // where src/a lands, under that directory
	}{
		{name: "an existing directory", dest: "", want: "src/a"},
		{name: "a new name", dest: "renamed", want: "renamed/a"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			archive := buildArchive(t, dirEntry("src/"), fileEntry("src/a", "1"))

			err := Extract(filepath.Join(dir, tc.dest), archive, ownOwner(), io.Discard)

			assert.NilError(t, err)
			assert.Equal(t, readFile(t, filepath.Join(dir, tc.want)), "1")
		})
	}
}

func TestExtractRefusesNamesThatLeaveTheCopyAndExtractsTheRest(t *testing.T) {
	dir := t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		fileEntry("src/../escape", "x"),
		fileEntry("/etc/escape", "x"),
		fileEntry("other/escape", "x"),
		fileEntry("src/ok", "fine"),
	)
	var warn bytes.Buffer

	err := Extract(dir, archive, ownOwner(), &warn)

	assert.Check(t, cmp.ErrorContains(err, "3 entries were not copied"))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(dir, "src", "ok")), "fine"))
	assert.Check(t, cmp.Contains(warn.String(), `src/../escape: a name with ".."`))
	assert.Check(t, cmp.Contains(warn.String(), "/etc/escape: an absolute name"))
	assert.Check(t, cmp.Contains(warn.String(), `other/escape: outside the copy's top "src"`))
	_, err = os.Lstat(filepath.Join(dir, "escape"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
	_, err = os.Lstat("/etc/escape")
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
	_, err = os.Lstat(filepath.Join(dir, "other"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
}

// A first entry that could leave the copy names no top, so nothing extracts.
func TestExtractFailsWhenTheFirstNameLeavesTheCopy(t *testing.T) {
	for _, tc := range []struct {
		name  string
		entry tar.Header
		want  string
	}{
		{name: "absolute", entry: fileEntry("/etc/escape", "x"), want: "an absolute name"},
		{name: "dot dot", entry: fileEntry("../escape", "x"), want: `a name with ".."`},
		{name: "empty", entry: dirEntry("./"), want: "an empty name"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			archive := buildArchive(t, tc.entry)

			err := Extract(dir, archive, ownOwner(), io.Discard)

			assert.Check(t, cmp.ErrorContains(err, tc.want))
			entries, rerr := os.ReadDir(dir)
			assert.NilError(t, rerr)
			assert.Check(t, cmp.Len(entries, 0))
		})
	}
}

func TestExtractFailsForAnEmptyArchive(t *testing.T) {
	archive := buildArchive(t)

	err := Extract(t.TempDir(), archive, ownOwner(), io.Discard)

	assert.ErrorContains(t, err, "the archive is empty")
}

// A directory entry where the imp has a file keeps the file.
func TestExtractRefusesADirectoryOverAFileInTheImp(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.WriteFile(filepath.Join(dir, "src"), []byte("mine"), 0o644))
	var warn bytes.Buffer

	err := Extract(dir, buildArchive(t, dirEntry("src/")), ownOwner(), &warn)

	assert.Check(t, cmp.ErrorContains(err, "1 entries were not copied"))
	assert.Check(t, cmp.Contains(warn.String(), "src/: not a directory in the imp"))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(dir, "src")), "mine"))
}

// A symlink in the archive and then a file through it: symlinks come last,
// so the file finds no directory there
func TestExtractRefusesAFileThroughASymlinkOfTheArchive(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		tar.Header{Typeflag: tar.TypeSymlink, Name: "src/link", Linkname: outside},
		fileEntry("src/link/planted", "x"),
	)

	err := Extract(dir, archive, ownOwner(), io.Discard)

	assert.Check(t, cmp.ErrorContains(err, "1 entries were not copied"))
	_, err = os.Lstat(filepath.Join(outside, "planted"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist), "the file went through the symlink")
	target, err := os.Readlink(filepath.Join(dir, "src", "link"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(target, outside))
}

// A symlink that was in the imp already, such as one a guest process put
// there, is not followed either
func TestExtractRefusesAFileThroughASymlinkInTheImp(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	assert.NilError(t, os.MkdirAll(filepath.Join(dir, "src"), 0o755))
	assert.NilError(t, os.Symlink(outside, filepath.Join(dir, "src", "sub")))
	archive := buildArchive(t, dirEntry("src/"), fileEntry("src/sub/planted", "x"))
	var warn bytes.Buffer

	err := Extract(dir, archive, ownOwner(), &warn)

	assert.Check(t, cmp.ErrorContains(err, "1 entries were not copied"))
	assert.Check(t, cmp.Contains(warn.String(), "under a symlink"))
	_, err = os.Lstat(filepath.Join(outside, "planted"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist), "the file went through the symlink")
}

func TestExtractKeepsHardLinksInsideTheCopy(t *testing.T) {
	dir := t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		fileEntry("src/a", "same"),
		tar.Header{Typeflag: tar.TypeLink, Name: "src/b", Linkname: "src/a"},
		tar.Header{Typeflag: tar.TypeLink, Name: "src/c", Linkname: "/etc/passwd"},
	)

	err := Extract(dir, archive, ownOwner(), io.Discard)

	assert.Check(t, cmp.ErrorContains(err, "1 entries were not copied"))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(dir, "src", "b")), "same"))
	_, err = os.Lstat(filepath.Join(dir, "src", "c"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist), "the hard link outside the copy was made")
}

func TestExtractSkipsDevicesAndDropsSetuid(t *testing.T) {
	dir := t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		tar.Header{Typeflag: tar.TypeChar, Name: "src/null", Devmajor: 1, Devminor: 3},
		tar.Header{Typeflag: tar.TypeFifo, Name: "src/fifo"},
		tar.Header{Typeflag: tar.TypeReg, Name: "src/suid", Linkname: "x", Mode: 0o6755},
	)
	var warn bytes.Buffer

	err := Extract(dir, archive, ownOwner(), &warn)

	assert.NilError(t, err)
	info, err := os.Stat(filepath.Join(dir, "src", "suid"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(info.Mode(), fs.FileMode(0o755)), "setuid or setgid kept")
	_, err = os.Lstat(filepath.Join(dir, "src", "null"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist), "the device was made")
	_, err = os.Lstat(filepath.Join(dir, "src", "fifo"))
	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist), "the FIFO was made")
	assert.Check(t, cmp.Equal(strings.Count(warn.String(), "skipped"), 2), warn.String())
}

// a file over a file replaces it; no temp file stays behind
func TestExtractReplacesAFileWithoutLeftovers(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.MkdirAll(filepath.Join(dir, "src"), 0o755))
	assert.NilError(t, os.WriteFile(filepath.Join(dir, "src", "a"), []byte("old"), 0o644))

	err := Extract(dir, buildArchive(t, fileEntry("src/a", "new")), ownOwner(), io.Discard)

	assert.NilError(t, err)
	entries, err := os.ReadDir(filepath.Join(dir, "src"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Len(entries, 1), "entries %v", entries)
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(dir, "src", "a")), "new"))
}

func TestResolveJoinsARelativePathToTheUsersHome(t *testing.T) {
	got, err := resolve("work/x", "")

	assert.NilError(t, err)
	assert.Equal(t, got, "/root/work/x")
}

func TestResolveCleansAnAbsolutePath(t *testing.T) {
	got, err := resolve("/srv/../etc", "")

	assert.NilError(t, err)
	assert.Equal(t, got, "/etc")
}

func TestResolveRefusesAnEmptyPath(t *testing.T) {
	_, err := resolve("", "")

	assert.ErrorContains(t, err, "an empty path")
}

func TestRunRefusesArgumentsOutsideTheUsage(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
	}{
		{name: "none", args: nil},
		{name: "an unknown command", args: []string{"list", "/srv"}},
		{name: "create without a path", args: []string{"create"}},
		{name: "extract with a stray flag", args: []string{"extract", "--owner", "/srv"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := Run(tc.args, strings.NewReader(""), io.Discard, io.Discard)

			assert.Error(t, err, "usage: imp-agent tar create <path> | extract [--owner SPEC] <dest>")
		})
	}
}

// ownership maps each name under dir to its uid:gid, without following
// symlinks.
func ownership(t *testing.T, dir string, names ...string) map[string][2]uint32 {
	t.Helper()
	got := map[string][2]uint32{}
	for _, name := range names {
		var st syscall.Stat_t
		assert.NilError(t, syscall.Lstat(filepath.Join(dir, name), &st))
		got[name] = [2]uint32{st.Uid, st.Gid}
	}
	return got
}

// As root: every entry the copy makes belongs to the owner; a directory
// that was there keeps its own
func TestExtractGivesEveryEntryToTheOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to chown")
	}
	dir := t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		fileEntry("src/a", "x"),
		tar.Header{Typeflag: tar.TypeSymlink, Name: "src/l", Linkname: "a"},
	)

	err := Extract(dir, archive, &Owner{UID: 4242, GID: 4343}, io.Discard)

	assert.NilError(t, err)
	assert.Check(t, cmp.DeepEqual(ownership(t, dir, "src", "src/a", "src/l"), map[string][2]uint32{
		"src":   {4242, 4343},
		"src/a": {4242, 4343},
		"src/l": {4242, 4343},
	}))
	assert.Check(t, cmp.DeepEqual(ownership(t, dir, "."), map[string][2]uint32{".": {0, 0}}))
}

// As root: with no owner, the copy belongs to the owner of the directory it
// lands in
func TestExtractWithNoOwnerGivesTheCopyToTheDirectorysOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to chown")
	}
	dir := t.TempDir()
	assert.NilError(t, os.Chown(dir, 4242, 4343))
	archive := buildArchive(t, dirEntry("src/"), fileEntry("src/a", "x"))

	err := Extract(dir, archive, nil, io.Discard)

	assert.NilError(t, err)
	assert.DeepEqual(t, ownership(t, dir, "src", "src/a"), map[string][2]uint32{
		"src":   {4242, 4343},
		"src/a": {4242, 4343},
	})
}

// zeros in the archive become holes, and a file that ends in zeros keeps its
// size
func TestExtractTurnsZerosIntoHoles(t *testing.T) {
	dir := t.TempDir()
	content := "head" + strings.Repeat("\x00", 1<<20) + "tail" + strings.Repeat("\x00", 1<<20)
	archive := buildArchive(t, fileEntry("sparse", content))

	err := Extract(dir, archive, ownOwner(), io.Discard)

	assert.NilError(t, err)
	path := filepath.Join(dir, "sparse")
	assert.Check(t, readFile(t, path) == content, "the content changed")
	var st syscall.Stat_t
	assert.NilError(t, syscall.Stat(path, &st))
	assert.Check(t, st.Blocks*512 < int64(len(content))/2, "%d bytes allocated for %d", st.Blocks*512, len(content))
}

// an archive cut inside a file fails it, and what was there stays
func TestExtractOfACutArchiveLeavesTheFileAlone(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.WriteFile(filepath.Join(dir, "f"), []byte("old"), 0o644))
	full := buildArchive(t, fileEntry("f", strings.Repeat("x", 10_000))).Bytes()
	cut := bytes.NewReader(full[:512+5_000])
	var warn bytes.Buffer

	err := Extract(dir, cut, ownOwner(), &warn)

	assert.Check(t, cmp.ErrorIs(err, io.ErrUnexpectedEOF))
	assert.Check(t, cmp.Contains(warn.String(), "the archive ended 5000 bytes into a 10000-byte file"))
	assert.Check(t, cmp.Equal(readFile(t, filepath.Join(dir, "f")), "old"))
	entries, err := os.ReadDir(dir)
	assert.NilError(t, err)
	assert.Check(t, cmp.Len(entries, 1), "a temp file was left: %v", entries)
}
