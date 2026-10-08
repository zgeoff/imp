package services

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/proto"
)

func TestFindLastLinesFindsTheStartOfTheLastNLines(t *testing.T) {
	for _, tc := range []struct {
		name  string
		body  string
		n     int
		want  string
		found int
	}{
		{name: "fewer than the file holds", body: "a\nb\nc\n", n: 2, want: "b\nc\n", found: 2},
		{name: "no final newline", body: "a\nb\nc", n: 2, want: "b\nc", found: 2},
		{name: "more than the file holds", body: "a\nb\nc\n", n: 5, want: "a\nb\nc\n", found: 3},
		{name: "none", body: "a\nb\nc\n", n: 0, want: "", found: 0},
		{name: "an empty file", body: "", n: 3, want: "", found: 0},
		{name: "one empty line", body: "\n", n: 1, want: "\n", found: 1},
		{name: "empty lines", body: "a\n\n\nb\n", n: 2, want: "\nb\n", found: 2},
		{name: "a line longer than a block before the last", body: strings.Repeat("x", tailBlock+10) + "\n" + "y\n", n: 1, want: "y\n", found: 1},
		{name: "a last line longer than two blocks", body: "z\n" + strings.Repeat("x", 2*tailBlock) + "\n", n: 1, want: strings.Repeat("x", 2*tailBlock) + "\n", found: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "log")
			assert.NilError(t, os.WriteFile(path, []byte(tc.body), 0o644))
			f, err := os.Open(path)
			assert.NilError(t, err)
			t.Cleanup(func() { f.Close() })

			start, found := findLastLines(f, int64(len(tc.body)), tc.n)

			assert.Check(t, tc.body[start:] == tc.want, "got %q, want %q", shorten(tc.body[start:]), shorten(tc.want))
			assert.Check(t, cmp.Equal(found, tc.found))
		})
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

// startLogs runs Logs in the background. Its cleanup ends the stream and
// joins both goroutines, draining frames nobody read.
func startLogs(t *testing.T, s *Supervisor, name string, lines int, follow bool, cursor *proto.LogCursor) *logStream {
	t.Helper()
	pr, pw := io.Pipe()
	ls := &logStream{frames: make(chan proto.Frame, 1024), done: make(chan struct{}), result: make(chan error, 1)}
	logsEnded := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-ls.done:
		default:
			close(ls.done)
		}
		deadline := time.After(5 * time.Second)
		for frames := ls.frames; frames != nil; {
			select {
			case _, ok := <-frames:
				if !ok {
					frames = nil
				}
			case <-deadline:
				t.Error("the stream's reader did not end")
				return
			}
		}
		select {
		case <-logsEnded:
		case <-deadline:
			t.Error("Logs did not return")
		}
	})
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
		defer close(logsEnded)
		err := s.Logs(name, LogRequest{Lines: lines, Follow: follow, Cursor: cursor}, proto.NewWriter(pw), ls.done)
		ls.result <- err
		pw.Close()
	}()
	return ls
}

// waitResponse waits for the RESPONSE, after which the tail is read.
func (ls *logStream) waitResponse(t *testing.T) {
	t.Helper()
	select {
	case f := <-ls.frames:
		assert.Equal(t, f.Type, proto.TypeResponse, "first frame %q", f.Payload)
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
			assert.Assert(t, ok, "the stream ended at %q, want %q", *text, want)
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
	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })
	_, err = f.WriteString(text)
	assert.NilError(t, err)
	assert.NilError(t, f.Close())
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
	err := <-ls.result

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(text, "2\n3\n4\n5\n"))
	assert.Assert(t, len(types) > 0, "no frames")
	assert.Check(t, cmp.Equal(types[0], proto.TypeResponse), "frames %v", types)
	assert.Check(t, cmp.Equal(types[len(types)-1], proto.TypeStdoutEOF), "frames %v", types)
}

func TestLogsRefusesABadRequest(t *testing.T) {
	for _, tc := range []struct {
		name    string
		service string
		lines   int
		code    string
	}{
		{name: "no such service", service: "nope", lines: 10, code: proto.ErrNoService},
		{name: "a path for a name", service: "../etc/passwd", lines: 10, code: proto.ErrNoService},
		{name: "negative lines", service: "web", lines: -1, code: proto.ErrBadRequest},
		{name: "too many lines", service: "web", lines: MaxLogLines + 1, code: proto.ErrBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newManagedSupervisor(t)

			err := s.Logs(tc.service, LogRequest{Lines: tc.lines}, proto.NewWriter(io.Discard), nil)

			requireCode(t, err, tc.code)
		})
	}
}

// The follow polls on a ticker, which runs on the bubble's fake clock.
func TestLogsFollowsTheLogThroughATruncateAndARename(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := newManagedSupervisor(t)
		path := filepath.Join(s.logDir, "web.log")
		appendTo(t, path, "old\n")
		ls := startLogs(t, s, "web", 0, true, nil)
		ls.waitResponse(t)
		text := ""

		appendTo(t, path, "a\n")
		ls.readUntil(t, &text, "a\n")
		// copytruncate by another tool: the file shrinks in place, and grows
		// back to less than the follow has read, so the follow sees the shrink
		// whenever it next looks
		assert.NilError(t, os.Truncate(path, 0))
		appendTo(t, path, "b\n")
		ls.readUntil(t, &text, "b\n")
		// rename, as a service start rotates: the rest of the old file comes
		// before the new one
		appendTo(t, path, "c\n")
		assert.NilError(t, os.Rename(path, path+".1"))
		appendTo(t, path, "d\n")
		ls.readUntil(t, &text, "d\n")
		close(ls.done)
		err := <-ls.result

		assert.Check(t, cmp.Equal(text, "a\nb\nc\nd\n"))
		assert.Check(t, err, "Logs")
	})
}

// A running service's own output reaches a follow, through the log the
// supervisor writes, after the tail it already had.
func TestLogsFollowsARunningServicesOutput(t *testing.T) {
	s := newManagedSupervisor(t)
	release := filepath.Join(t.TempDir(), "release")
	s.Start(Def{Name: "web", Argv: []string{"sh", "-c", "echo started; while [ ! -e " + release + " ]; do sleep 0.01; done; echo later; exec sleep 30"}, Restart: "always"})
	waitRunning(t, s, "web", 0)
	ls := startLogs(t, s, "web", 10, true, nil)
	ls.waitResponse(t)
	text := ""
	ls.readUntil(t, &text, "started\n")

	assert.NilError(t, os.WriteFile(release, nil, 0o600))
	ls.readUntil(t, &text, "later\n")

	assert.Check(t, cmp.Equal(text, "started\nlater\n"))
}

func TestLogsFollowsTheRotatorsCopytruncate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := newManagedSupervisor(t)
		path := filepath.Join(s.logDir, "web.log")
		writeLog(t, path, maxLogSize+1, "old\n")
		ls := startLogs(t, s, "web", 0, true, nil)
		ls.waitResponse(t)

		// a line the follow has not read yet goes only into the copy, and the
		// file grows back past the follow's offset before the follow looks
		appendTo(t, path, "between\n")
		assert.NilError(t, s.copyTruncateLog(path))
		const regrown = maxLogSize + 20
		assert.NilError(t, os.Truncate(path, regrown))
		appendTo(t, path, "after\n")
		text := ""
		ls.readUntil(t, &text, "after\n")

		assert.Check(t, cmp.Equal(len(text), len("between\n")+regrown+len("after\n")))
		assert.Check(t, strings.HasPrefix(text, "between\n"), "the text starts %q, want between, then the whole new file", shorten(text))
	})
}

func inodeOfPath(t *testing.T, path string) uint64 {
	t.Helper()
	fi, err := os.Stat(path)
	assert.NilError(t, err)
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
			assert.NilError(t, json.Unmarshal(f.Payload, &last))
		}
	}
	assert.NilError(t, <-ls.result)
	return text, last
}

func TestLogsSendsACursorAfterEachChunk(t *testing.T) {
	s := newManagedSupervisor(t)
	path := filepath.Join(s.logDir, "web.log")
	appendTo(t, path, "1\n2\n3\n")

	text, last := collect(t, startLogs(t, s, "web", 10, false, nil))

	assert.Check(t, cmp.Equal(text, "1\n2\n3\n"))
	assert.Check(t, cmp.Equal(last, proto.LogCursor{Inode: inodeOfPath(t, path), Offset: 6}))
}

func TestLogsResumesFromACursorInTheSameFileWithNoLineTwice(t *testing.T) {
	s := newManagedSupervisor(t)
	path := filepath.Join(s.logDir, "web.log")
	appendTo(t, path, "1\n2\n")
	ino := inodeOfPath(t, path)
	// more lines while the stream was away
	appendTo(t, path, "3\n")

	text, _ := collect(t, startLogs(t, s, "web", 10, false, &proto.LogCursor{Inode: ino, Offset: 4}))

	assert.Check(t, cmp.Equal(text, "3\n"))
}

// A start rotated the file to .1, with a line after the cursor in it.
func TestLogsResumesFromACursorInTheRotatedFile(t *testing.T) {
	s := newManagedSupervisor(t)
	path := filepath.Join(s.logDir, "web.log")
	appendTo(t, path, "1\n2\n")
	ino := inodeOfPath(t, path)
	appendTo(t, path, "3\n")
	assert.NilError(t, os.Rename(path, path+".1"))
	appendTo(t, path, "4\n")

	text, last := collect(t, startLogs(t, s, "web", 10, false, &proto.LogCursor{Inode: ino, Offset: 4}))

	assert.Check(t, cmp.Equal(text, "3\n4\n"))
	assert.Check(t, cmp.Equal(last, proto.LogCursor{Inode: inodeOfPath(t, path), Offset: 2}))
}

// A cursor in neither file: the current one goes whole.
func TestLogsSendsTheWholeCurrentFileForACursorInNeitherFile(t *testing.T) {
	s := newManagedSupervisor(t)
	path := filepath.Join(s.logDir, "web.log")
	appendTo(t, path, "1\n2\n3\n")
	ino := inodeOfPath(t, path)
	assert.NilError(t, os.Rename(path, path+".1"))
	appendTo(t, path, "4\n")

	text, _ := collect(t, startLogs(t, s, "web", 10, false, &proto.LogCursor{Inode: ino + 1000, Offset: 1}))

	assert.Check(t, cmp.Equal(text, "4\n"))
}

// A cursor past the end of a file that shrank: from 0.
func TestLogsSendsTheFileFromTheStartForACursorPastItsEnd(t *testing.T) {
	s := newManagedSupervisor(t)
	path := filepath.Join(s.logDir, "web.log")
	appendTo(t, path, "4\n")

	text, _ := collect(t, startLogs(t, s, "web", 10, false, &proto.LogCursor{Inode: inodeOfPath(t, path), Offset: 50}))

	assert.Check(t, cmp.Equal(text, "4\n"))
}
