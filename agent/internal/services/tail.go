package services

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
)

const (
	// MaxLogLines bounds the lines services.logs sends before it follows.
	MaxLogLines = 100_000
	tailBlock   = 64 << 10
	followEvery = 250 * time.Millisecond
)

// LogRequest is what services.logs asks for: the last Lines lines, or with
// Cursor, everything after it; and with Follow, what comes after that.
type LogRequest struct {
	Lines  int
	Follow bool
	Cursor *proto.LogCursor
}

// Logs streams a service's log on w: a RESPONSE {"ok":true}, then STDOUT
// frames, each followed by a CURSOR that names the file and the offset the
// stream has reached. Without Follow, STDOUT_EOF ends it. With Follow, it
// sends what the service writes until done closes, through both kinds of
// rotation. A removed service's log still streams; a name with no service
// and no log is NO_SERVICE.
func (s *Supervisor) Logs(name string, req LogRequest, w *proto.Writer, done <-chan struct{}) error {
	if req.Lines < 0 || req.Lines > MaxLogLines {
		return badRequest("lines: want 0 to 100000")
	}
	path := filepath.Join(s.logDir, name+".log")
	if filepath.Base(path) != name+".log" || s.find(name) == nil && !exists(path) && !exists(path+".1") {
		return noService(name)
	}
	// opened before the reply, so what comes first and the follow meet at
	// the same offset for everything written after it
	cur, size, err := openLogFile(path)
	if err != nil {
		return err
	}
	if err := w.WriteJSON(proto.TypeResponse, proto.OK{OK: true}); err != nil {
		cur.close()
		return err
	}
	if req.Cursor != nil {
		err = sendFromCursor(path, cur, size, *req.Cursor, w)
	} else {
		err = sendTail(path, cur, size, req.Lines, w)
	}
	if err != nil {
		cur.close()
		return err
	}
	if !req.Follow {
		cur.close()
		return w.Write(proto.TypeStdoutEOF, nil)
	}
	return s.followLog(path, cur, w, done)
}

// logFile is an open log, its inode, and how far into it the stream has
// sent.
type logFile struct {
	f      *os.File
	ino    uint64
	offset int64
}

// openLogFile opens a log and reads its size; nil when it does not exist.
func openLogFile(path string) (*logFile, int64, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return &logFile{f: f, ino: inodeOf(fi)}, fi.Size(), nil
}

func (lf *logFile) close() {
	if lf != nil {
		lf.f.Close()
	}
}

// send sends the file from its offset to end, a CURSOR after each chunk.
func (lf *logFile) send(end int64, w *proto.Writer) error {
	buf := make([]byte, tailBlock)
	for lf.offset < end {
		chunk := buf[:min(int64(len(buf)), end-lf.offset)]
		k, err := lf.f.ReadAt(chunk, lf.offset)
		if k > 0 {
			if err := w.Write(proto.TypeStdout, chunk[:k]); err != nil {
				return err
			}
			lf.offset += int64(k)
			if err := w.WriteJSON(proto.TypeCursor, proto.LogCursor{Inode: lf.ino, Offset: lf.offset}); err != nil {
				return err
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
	return nil
}

// sendTail sends the last n lines across <path>.1 and the first size bytes
// of cur, and leaves cur at size.
func sendTail(path string, cur *logFile, size int64, n int, w *proto.Writer) error {
	start, found := int64(0), 0
	if cur != nil {
		start, found = findLastLines(cur.f, size, n)
	}
	if found < n {
		old, oldSize, err := openLogFile(path + ".1")
		if err != nil {
			return err
		}
		if old != nil {
			old.offset, _ = findLastLines(old.f, oldSize, n-found)
			err := old.send(oldSize, w)
			old.close()
			if err != nil {
				return err
			}
		}
	}
	if cur == nil {
		return nil
	}
	cur.offset = start
	return cur.send(size, w)
}

// sendFromCursor sends what comes after the cursor and leaves cur at size.
// The cursor names <path> itself, or <path>.1 once a start rotated it
// there; a file that shrank below it (a copytruncate) starts again from 0.
// A cursor in neither file is a log rotated past it: <path> goes whole.
func sendFromCursor(path string, cur *logFile, size int64, c proto.LogCursor, w *proto.Writer) error {
	if cur != nil && cur.ino == c.Inode {
		if c.Offset <= size {
			cur.offset = c.Offset
		}
		return cur.send(size, w)
	}
	old, oldSize, err := openLogFile(path + ".1")
	if err != nil {
		return err
	}
	if old != nil && old.ino == c.Inode {
		if c.Offset <= oldSize {
			old.offset = c.Offset
		}
		err = old.send(oldSize, w)
	}
	old.close()
	if err != nil || cur == nil {
		return err
	}
	return cur.send(size, w)
}

// findLastLines returns where the last n lines of f's first size bytes
// start, reading back a block at a time, and how many lines it found. A
// last line without a newline counts as a line.
func findLastLines(f *os.File, size int64, n int) (int64, int) {
	if n == 0 || size == 0 {
		return size, 0
	}
	buf := make([]byte, tailBlock)
	end := size
	found := 0
	// the newline that ends the file ends the last line, not one before it
	skip := true
	for end > 0 {
		start := max(end-tailBlock, 0)
		chunk := buf[:end-start]
		if _, err := f.ReadAt(chunk, start); err != nil && !errors.Is(err, io.EOF) {
			return start, found
		}
		for i := len(chunk) - 1; i >= 0; i-- {
			if chunk[i] != '\n' {
				skip = false
				continue
			}
			if skip {
				skip = false
				continue
			}
			found++
			if found == n {
				return start + int64(i) + 1, found
			}
		}
		end = start
	}
	if !skip {
		found++
	}
	return 0, min(found, n)
}

// followLog polls the log. A rotation by rename (at a service start) leaves
// a new file at path: the rest of the old one goes first. A copytruncate
// (the rotator) empties the file: the rest of the copy in <path>.1 goes
// first, then reading starts again from 0.
func (s *Supervisor) followLog(path string, cur *logFile, w *proto.Writer, done <-chan struct{}) error {
	defer func() { cur.close() }()
	truncs, _, err := s.readLogState(path)
	if err != nil {
		return err
	}
	t := time.NewTicker(followEvery)
	defer t.Stop()
	for {
		select {
		case <-done:
			return nil
		case <-t.C:
		}
		now, fi, err := s.readLogState(path)
		if err != nil {
			return err
		}
		if cur != nil && (fi == nil || inodeOf(fi) != cur.ino) {
			if err := sendNew(cur, w); err != nil {
				return err
			}
			cur.close()
			cur = nil
		}
		if cur != nil && now != truncs {
			if err := sendCopyRest(path, cur.offset, w); err != nil {
				return err
			}
			cur.offset = 0
		}
		truncs = now
		if cur == nil && fi != nil {
			cur, _, err = openLogFile(path)
			if err != nil {
				return err
			}
		}
		if cur != nil {
			if err := sendNew(cur, w); err != nil {
				return err
			}
		}
	}
}

// sendCopyRest sends what a copytruncate copied to <path>.1 past offset:
// what the service wrote after the follow's last read.
func sendCopyRest(path string, offset int64, w *proto.Writer) error {
	old, size, err := openLogFile(path + ".1")
	if err != nil || old == nil {
		return err
	}
	defer old.close()
	if offset > size {
		return nil
	}
	old.offset = offset
	return old.send(size, w)
}

// sendNew sends what was written past the offset, from 0 after a truncate
// the rotator did not do.
func sendNew(cur *logFile, w *proto.Writer) error {
	fi, err := cur.f.Stat()
	if err != nil {
		return err
	}
	if fi.Size() < cur.offset {
		cur.offset = 0
	}
	return cur.send(fi.Size(), w)
}

func inodeOf(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Ino
	}
	return 0
}
