package services

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
)

func syscallKill(pid int) error {
	return syscall.Kill(pid, 0)
}

func TestFindLastLines(t *testing.T) {
	tests := []struct {
		body  string
		n     int
		want  string
		found int
	}{
		{"a\nb\nc\n", 2, "b\nc\n", 2},
		{"a\nb\nc", 2, "b\nc", 2},
		{"a\nb\nc\n", 5, "a\nb\nc\n", 3},
		{"a\nb\nc\n", 0, "", 0},
		{"", 3, "", 0},
		{"\n", 1, "\n", 1},
		{"a\n\n\nb\n", 2, "\nb\n", 2},
		// lines across the block size
		{strings.Repeat("x", tailBlock+10) + "\n" + "y\n", 1, "y\n", 1},
		{"z\n" + strings.Repeat("x", 2*tailBlock) + "\n", 1, strings.Repeat("x", 2*tailBlock) + "\n", 1},
	}
	dir := t.TempDir()
	for i, tt := range tests {
		path := filepath.Join(dir, "log")
		if err := os.WriteFile(path, []byte(tt.body), 0o644); err != nil {
			t.Fatal(err)
		}
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		start, found := findLastLines(f, int64(len(tt.body)), tt.n)
		f.Close()
		if got := tt.body[start:]; got != tt.want || found != tt.found {
			t.Errorf("case %d: got %q (%d lines), want %q (%d)", i, shorten(got), found, shorten(tt.want), tt.found)
		}
	}
}

func shorten(s string) string {
	if len(s) > 20 {
		return s[:10] + "…" + s[len(s)-5:]
	}
	return s
}

// logStream runs Logs on a pipe and collects what it sends.
type logStream struct {
	frames chan proto.Frame
	done   chan struct{}
	result chan error
}

func startLogs(t *testing.T, s *Supervisor, name string, lines int, follow bool, cursor *proto.LogCursor) *logStream {
	t.Helper()
	pr, pw := io.Pipe()
	ls := &logStream{frames: make(chan proto.Frame, 1024), done: make(chan struct{}), result: make(chan error, 1)}
	go func() {
		r := proto.NewReader(pr)
		for {
			f, err := r.Next()
			if err != nil {
				close(ls.frames)
				return
			}
			ls.frames <- f
		}
	}()
	go func() {
		err := s.Logs(name, LogRequest{Lines: lines, Follow: follow, Cursor: cursor}, proto.NewWriter(pw), ls.done)
		ls.result <- err
		pw.Close()
	}()
	t.Cleanup(func() {
		select {
		case <-ls.done:
		default:
			close(ls.done)
		}
	})
	return ls
}

// waitResponse waits for the RESPONSE, after which the tail is read.
func (ls *logStream) waitResponse(t *testing.T) {
	t.Helper()
	select {
	case f := <-ls.frames:
		if f.Type != proto.TypeResponse {
			t.Fatalf("first frame %s, want RESPONSE", f.Type)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no RESPONSE")
	}
}

// readUntil collects STDOUT until the text ends with want.
func (ls *logStream) readUntil(t *testing.T, text *string, want string) {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for !strings.HasSuffix(*text, want) {
		select {
		case f, ok := <-ls.frames:
			if !ok {
				t.Fatalf("the stream ended at %q, want %q", *text, want)
			}
			if f.Type == proto.TypeStdout {
				*text += string(f.Payload)
			}
		case <-timeout:
			select {
			case err := <-ls.result:
				t.Fatalf("logs returned %v at %q", err, *text)
			default:
			}
			t.Fatalf("got %q, want it to end with %q", *text, want)
		}
	}
}

func appendTo(t *testing.T, path, text string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

func TestLogsSendsTheTailAcrossTheRotatedLog(t *testing.T) {
	s := newManagedSupervisor(t)
	path := filepath.Join(s.logDir, "web.log")
	appendTo(t, path+".1", "1\n2\n3\n")
	appendTo(t, path, "4\n5\n")

	ls := startLogs(t, s, "web", 4, false, nil)
	var types []proto.Type
	text := ""
	for f := range ls.frames {
		types = append(types, f.Type)
		if f.Type == proto.TypeStdout {
			text += string(f.Payload)
		}
	}
	if err := <-ls.result; err != nil {
		t.Fatal(err)
	}
	if text != "2\n3\n4\n5\n" {
		t.Fatalf("text = %q", text)
	}
	if types[0] != proto.TypeResponse || types[len(types)-1] != proto.TypeStdoutEOF {
		t.Fatalf("frames %v: want RESPONSE first and STDOUT_EOF last", types)
	}
}

func TestLogsOfNoServiceIsRefused(t *testing.T) {
	s := newManagedSupervisor(t)
	discard := proto.NewWriter(io.Discard)
	requireCode(t, s.Logs("nope", LogRequest{Lines: 10}, discard, nil), proto.ErrNoService)
	requireCode(t, s.Logs("../etc/passwd", LogRequest{Lines: 10}, discard, nil), proto.ErrNoService)
	requireCode(t, s.Logs("web", LogRequest{Lines: -1}, discard, nil), proto.ErrBadRequest)
}

func TestLogsFollowsThroughBothRotations(t *testing.T) {
	s := newManagedSupervisor(t)
	s.Start(Def{Name: "web", Argv: []string{"sleep", "30"}, Restart: "always"})
	path := filepath.Join(s.logDir, "web.log")
	waitRunning(t, s, "web", 0)
	appendTo(t, path, "old\n")

	ls := startLogs(t, s, "web", 0, true, nil)
	ls.waitResponse(t)
	text := ""
	appendTo(t, path, "a\n")
	ls.readUntil(t, &text, "a\n")

	// copytruncate: the file shrinks in place
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * followEvery)
	appendTo(t, path, "b\n")
	ls.readUntil(t, &text, "b\n")

	// rename, as a service start rotates: the rest of the old file comes
	// before the new one
	appendTo(t, path, "c\n")
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendTo(t, path, "d\n")
	ls.readUntil(t, &text, "d\n")

	if text != "a\nb\nc\nd\n" {
		t.Fatalf("text = %q", text)
	}
	close(ls.done)
	if err := <-ls.result; err != nil {
		t.Fatal(err)
	}
}

func TestLogsFollowsTheRotatorsCopytruncate(t *testing.T) {
	s := newManagedSupervisor(t)
	s.Start(Def{Name: "web", Argv: []string{"sleep", "30"}, Restart: "always"})
	path := filepath.Join(s.logDir, "web.log")
	waitRunning(t, s, "web", 0)
	writeLog(t, path, maxLogSize+1, "old\n")

	ls := startLogs(t, s, "web", 0, true, nil)
	ls.waitResponse(t)
	// a line the follow has not read yet goes only into the copy, and the
	// file grows back past the follow's offset before the follow looks
	appendTo(t, path, "between\n")
	if err := s.copyTruncateLog(path); err != nil {
		t.Fatal(err)
	}
	const regrown = maxLogSize + 20
	if err := os.Truncate(path, regrown); err != nil {
		t.Fatal(err)
	}
	appendTo(t, path, "after\n")

	text := ""
	ls.readUntil(t, &text, "after\n")
	if !strings.HasPrefix(text, "between\n") || len(text) != len("between\n")+regrown+len("after\n") {
		t.Fatalf("got %d bytes starting %q; want between, then the whole new file", len(text), shorten(text))
	}
}

func inodeOfPath(t *testing.T, path string) uint64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return inodeOf(fi)
}

// collect runs a stream without follow and returns its text and last cursor.
func collect(t *testing.T, ls *logStream) (string, proto.LogCursor) {
	t.Helper()
	text := ""
	var last proto.LogCursor
	for f := range ls.frames {
		switch f.Type {
		case proto.TypeStdout:
			text += string(f.Payload)
		case proto.TypeCursor:
			if err := json.Unmarshal(f.Payload, &last); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := <-ls.result; err != nil {
		t.Fatal(err)
	}
	return text, last
}

func TestLogsSendsACursorAfterEachChunk(t *testing.T) {
	s := newManagedSupervisor(t)
	path := filepath.Join(s.logDir, "web.log")
	appendTo(t, path, "1\n2\n3\n")

	text, last := collect(t, startLogs(t, s, "web", 10, false, nil))
	want := proto.LogCursor{Inode: inodeOfPath(t, path), Offset: 6}
	if text != "1\n2\n3\n" || last != want {
		t.Fatalf("text %q, cursor %+v; want cursor %+v", text, last, want)
	}
}

func TestLogsResumeFromACursorWithNoLineTwice(t *testing.T) {
	s := newManagedSupervisor(t)
	path := filepath.Join(s.logDir, "web.log")
	appendTo(t, path, "1\n2\n")
	ino := inodeOfPath(t, path)

	// more lines while the stream was away
	appendTo(t, path, "3\n")
	text, _ := collect(t, startLogs(t, s, "web", 10, false, &proto.LogCursor{Inode: ino, Offset: 4}))
	if text != "3\n" {
		t.Fatalf("same file: %q", text)
	}

	// a start rotated the file to .1, with a line after the cursor in it
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendTo(t, path, "4\n")
	text, last := collect(t, startLogs(t, s, "web", 10, false, &proto.LogCursor{Inode: ino, Offset: 4}))
	if text != "3\n4\n" || last.Inode != inodeOfPath(t, path) || last.Offset != 2 {
		t.Fatalf("after a rename: %q, cursor %+v", text, last)
	}

	// a cursor in neither file: the current one goes whole
	text, _ = collect(t, startLogs(t, s, "web", 10, false, &proto.LogCursor{Inode: ino + 1000, Offset: 1}))
	if text != "4\n" {
		t.Fatalf("lost cursor: %q", text)
	}

	// past the end of a file that shrank: from 0
	text, _ = collect(t, startLogs(t, s, "web", 10, false, &proto.LogCursor{Inode: inodeOfPath(t, path), Offset: 50}))
	if text != "4\n" {
		t.Fatalf("truncated: %q", text)
	}
}
