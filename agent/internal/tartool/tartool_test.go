package tartool

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
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
		if err := tw.WriteHeader(&hdr); err != nil {
			t.Fatal(err)
		}
		io.WriteString(tw, content)
	}
	tw.Close()
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
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestARoundTripKeepsModesTimesAndSymlinks(t *testing.T) {
	src := filepath.Join(t.TempDir(), "proj")
	os.MkdirAll(filepath.Join(src, "bin"), 0o750)
	os.WriteFile(filepath.Join(src, "bin", "run"), []byte("#!/bin/sh\n"), 0o755)
	os.WriteFile(filepath.Join(src, "notes with spaces.txt"), []byte("hello"), 0o600)
	os.Symlink("bin/run", filepath.Join(src, "link"))
	stamp := time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC)
	os.Chtimes(filepath.Join(src, "bin", "run"), stamp, stamp)

	var archive, warn bytes.Buffer
	if err := Create(src, &archive, &warn); err != nil {
		t.Fatal(err)
	}

	first, err := tar.NewReader(bytes.NewReader(archive.Bytes())).Next()
	if err != nil {
		t.Fatal(err)
	}
	if first.Name != "proj/" || first.PAXRecords[TotalRecord] != "15" {
		t.Fatalf("first entry %q with %v, want proj/ with %s=15", first.Name, first.PAXRecords, TotalRecord)
	}

	dest := t.TempDir()
	if err := Extract(dest, &archive, ownOwner(), &warn); err != nil {
		t.Fatalf("%v: %s", err, warn.String())
	}
	out := filepath.Join(dest, "proj")
	run, _ := os.Stat(filepath.Join(out, "bin", "run"))
	bin, _ := os.Stat(filepath.Join(out, "bin"))
	notes, _ := os.Stat(filepath.Join(out, "notes with spaces.txt"))
	link, _ := os.Readlink(filepath.Join(out, "link"))
	if run.Mode().Perm() != 0o755 || bin.Mode().Perm() != 0o750 || notes.Mode().Perm() != 0o600 {
		t.Fatalf("modes %v %v %v", run.Mode(), bin.Mode(), notes.Mode())
	}
	if !run.ModTime().Equal(stamp) {
		t.Fatalf("mtime %v, want %v", run.ModTime(), stamp)
	}
	if link != "bin/run" || readFile(t, filepath.Join(out, "notes with spaces.txt")) != "hello" {
		t.Fatalf("link %q", link)
	}
}

// As cp -r: into dest/<top> when dest is a directory, else as dest
func TestTheTopLandsInAnExistingDirectoryOrTakesTheDestName(t *testing.T) {
	dir := t.TempDir()
	archive := func() *bytes.Buffer {
		return buildArchive(t, dirEntry("src/"), fileEntry("src/a", "1"))
	}

	if err := Extract(dir, archive(), ownOwner(), io.Discard); err != nil {
		t.Fatal(err)
	}
	renamed := filepath.Join(dir, "renamed")
	if err := Extract(renamed, archive(), ownOwner(), io.Discard); err != nil {
		t.Fatal(err)
	}

	if readFile(t, filepath.Join(dir, "src", "a")) != "1" || readFile(t, filepath.Join(renamed, "a")) != "1" {
		t.Fatal("wrong places")
	}
}

func TestNamesThatLeaveTheCopyAreRefusedAndTheRestExtracts(t *testing.T) {
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

	if err == nil || !strings.Contains(err.Error(), "3 entries were not copied") {
		t.Fatalf("got %v", err)
	}
	if readFile(t, filepath.Join(dir, "src", "ok")) != "fine" {
		t.Fatal("the good entry is missing")
	}
	for _, path := range []string{filepath.Join(dir, "escape"), "/etc/escape", filepath.Join(dir, "other")} {
		if _, err := os.Lstat(path); err == nil {
			t.Fatalf("%s was written", path)
		}
	}
}

// A symlink in the archive and then a file through it: symlinks come last,
// so the file finds no directory there
func TestAFileThroughASymlinkOfTheArchiveIsRefused(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		tar.Header{Typeflag: tar.TypeSymlink, Name: "src/link", Linkname: outside},
		fileEntry("src/link/planted", "x"),
	)

	err := Extract(dir, archive, ownOwner(), io.Discard)

	if err == nil {
		t.Fatal("the extract succeeded")
	}
	if _, err := os.Lstat(filepath.Join(outside, "planted")); err == nil {
		t.Fatal("the file went through the symlink")
	}
	if target, _ := os.Readlink(filepath.Join(dir, "src", "link")); target != outside {
		t.Fatalf("the symlink itself is %q", target)
	}
}

// A symlink that was in the imp already, such as one a guest process put
// there, is not followed either
func TestAFileThroughASymlinkInTheImpIsRefused(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	os.Symlink(outside, filepath.Join(dir, "src", "sub"))
	archive := buildArchive(t, dirEntry("src/"), fileEntry("src/sub/planted", "x"))

	var warn bytes.Buffer
	err := Extract(dir, archive, ownOwner(), &warn)

	if err == nil || !strings.Contains(warn.String(), "under a symlink") {
		t.Fatalf("got %v: %s", err, warn.String())
	}
	if _, err := os.Lstat(filepath.Join(outside, "planted")); err == nil {
		t.Fatal("the file went through the symlink")
	}
}

func TestHardLinksStayInsideTheCopy(t *testing.T) {
	dir := t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		fileEntry("src/a", "same"),
		tar.Header{Typeflag: tar.TypeLink, Name: "src/b", Linkname: "src/a"},
		tar.Header{Typeflag: tar.TypeLink, Name: "src/c", Linkname: "/etc/passwd"},
	)

	err := Extract(dir, archive, ownOwner(), io.Discard)

	if err == nil || !strings.Contains(err.Error(), "1 entries") {
		t.Fatalf("got %v", err)
	}
	if readFile(t, filepath.Join(dir, "src", "b")) != "same" {
		t.Fatal("the hard link inside the copy is missing")
	}
	if _, err := os.Lstat(filepath.Join(dir, "src", "c")); err == nil {
		t.Fatal("the hard link outside the copy was made")
	}
}

func TestDevicesAreSkippedAndSetuidIsDropped(t *testing.T) {
	dir := t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		tar.Header{Typeflag: tar.TypeChar, Name: "src/null", Devmajor: 1, Devminor: 3},
		tar.Header{Typeflag: tar.TypeFifo, Name: "src/fifo"},
		tar.Header{Typeflag: tar.TypeReg, Name: "src/suid", Linkname: "x", Mode: 0o6755},
	)
	var warn bytes.Buffer

	if err := Extract(dir, archive, ownOwner(), &warn); err != nil {
		t.Fatal(err)
	}

	info, _ := os.Stat(filepath.Join(dir, "src", "suid"))
	if info.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 || info.Mode().Perm() != 0o755 {
		t.Fatalf("mode %v", info.Mode())
	}
	for _, name := range []string{"null", "fifo"} {
		if _, err := os.Lstat(filepath.Join(dir, "src", name)); err == nil {
			t.Fatalf("%s was made", name)
		}
	}
	if strings.Count(warn.String(), "skipped") != 2 {
		t.Fatalf("warnings: %s", warn.String())
	}
}

// a file over a file replaces it; no temp file stays behind
func TestAFileReplacesTheOneThereWithoutLeftovers(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	os.WriteFile(filepath.Join(dir, "src", "a"), []byte("old"), 0o644)

	if err := Extract(dir, buildArchive(t, fileEntry("src/a", "new")), ownOwner(), io.Discard); err != nil {
		t.Fatal(err)
	}

	entries, _ := os.ReadDir(filepath.Join(dir, "src"))
	if len(entries) != 1 || readFile(t, filepath.Join(dir, "src", "a")) != "new" {
		t.Fatalf("entries %v", entries)
	}
}

func TestARelativePathResolvesAgainstTheUsersHome(t *testing.T) {
	got, err := resolve("work/x", "")
	if err != nil || got != "/root/work/x" {
		t.Fatalf("got %q %v", got, err)
	}
	got, _ = resolve("/srv/../etc", "")
	if got != "/etc" {
		t.Fatalf("got %q", got)
	}
}

// As root: every entry the copy makes belongs to the owner; a directory
// that was there keeps its own
func TestEntriesBelongToTheOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to chown")
	}
	dir := t.TempDir()
	archive := buildArchive(t,
		dirEntry("src/"),
		fileEntry("src/a", "x"),
		tar.Header{Typeflag: tar.TypeSymlink, Name: "src/l", Linkname: "a"},
	)

	if err := Extract(dir, archive, &Owner{UID: 4242, GID: 4343}, io.Discard); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"src", "src/a", "src/l"} {
		var st syscall.Stat_t
		if err := syscall.Lstat(filepath.Join(dir, name), &st); err != nil {
			t.Fatal(err)
		}
		if st.Uid != 4242 || st.Gid != 4343 {
			t.Fatalf("%s is %d:%d", name, st.Uid, st.Gid)
		}
	}
	var top syscall.Stat_t
	syscall.Stat(dir, &top)
	if top.Uid != 0 {
		t.Fatalf("the existing directory became %d", top.Uid)
	}
}

// As root: with no owner, the copy belongs to the owner of the directory it
// lands in
func TestWithNoOwnerTheCopyTakesTheDirectorysOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to chown")
	}
	dir := t.TempDir()
	if err := os.Chown(dir, 4242, 4343); err != nil {
		t.Fatal(err)
	}
	archive := buildArchive(t, dirEntry("src/"), fileEntry("src/a", "x"))

	if err := Extract(dir, archive, nil, io.Discard); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"src", "src/a"} {
		var st syscall.Stat_t
		if err := syscall.Lstat(filepath.Join(dir, name), &st); err != nil {
			t.Fatal(err)
		}
		if st.Uid != 4242 || st.Gid != 4343 {
			t.Fatalf("%s is %d:%d", name, st.Uid, st.Gid)
		}
	}
}

// zeros in the archive become holes, and a file that ends in zeros keeps its
// size
func TestZerosBecomeHoles(t *testing.T) {
	dir := t.TempDir()
	content := "head" + strings.Repeat("\x00", 1<<20) + "tail" + strings.Repeat("\x00", 1<<20)
	archive := buildArchive(t, fileEntry("sparse", content))

	if err := Extract(dir, archive, ownOwner(), io.Discard); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, "sparse")
	if readFile(t, path) != content {
		t.Fatal("the content changed")
	}
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		t.Fatal(err)
	}
	if st.Blocks*512 >= int64(len(content))/2 {
		t.Fatalf("%d bytes allocated for %d", st.Blocks*512, len(content))
	}
}

// an archive cut inside a file fails it, and what was there stays
func TestACutArchiveLeavesTheFileAlone(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	full := buildArchive(t, fileEntry("f", strings.Repeat("x", 10_000))).Bytes()
	cut := bytes.NewReader(full[:512+5_000])

	if err := Extract(dir, cut, ownOwner(), io.Discard); err == nil {
		t.Fatal("a cut archive extracted")
	}

	if got := readFile(t, filepath.Join(dir, "f")); got != "old" {
		t.Fatalf("the file became %d bytes", len(got))
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("%d entries; a temp file was left", len(entries))
	}
}
