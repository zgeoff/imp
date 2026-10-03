package session

import (
	"encoding/json"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// maxQueued bounds the bytes a viewer may have waiting to be written,
// the batch being written included. A viewer that falls this far behind is
// dropped, so a slow host connection never holds up the pty and the program
// behind it.
const maxQueued = 2 << 20

// exitLinger bounds how long a connection waits for the host to close after
// EXIT, as in exec: a host frame that races the exit must not hit a closed
// socket.
const exitLinger = 2 * time.Second

// lastWriteTimeout bounds the writes of a viewer that was taken over or
// dropped: a host that stopped reading must not keep its connection, and the
// goroutines behind it, forever. A variable so tests can shorten it.
var lastWriteTimeout = 5 * time.Second

type frame struct {
	typ     proto.Type
	payload []byte
	// written, if set, runs once the frame is written.
	written func()
}

// viewer is one attached connection. The session queues frames for it
// without blocking; the viewer's own goroutine writes them out.
type viewer struct {
	conn net.Conn
	w    *proto.Writer

	mu    sync.Mutex
	queue []frame
	// queued counts the bytes in queue and in the batch being written.
	queued int
	// last, once set, is written after the queue; then the viewer stops.
	last    *frame
	stopped bool
	wake    chan struct{}

	// done closes when the writer has stopped.
	done chan struct{}

	// written counts the STDOUT bytes written out: how far a tap has read
	written atomic.Uint64
}

func newViewer(conn net.Conn, w *proto.Writer) *viewer {
	return &viewer{conn: conn, w: w, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

// push queues f. It returns false, and queues nothing, when the viewer is
// too far behind or has stopped.
func (v *viewer) push(f frame) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.stopped || v.queued+len(f.payload) > maxQueued {
		return false
	}
	v.queue = append(v.queue, f)
	v.queued += len(f.payload)
	v.signal()
	return true
}

// pushJSON queues a JSON frame. It panics on a value that cannot marshal,
// which is a bug in the caller.
func (v *viewer) pushJSON(typ proto.Type, value any) bool {
	return v.push(frame{typ: typ, payload: mustJSON(value)})
}

// stop ends the viewer once the queue is out. last, if not nil, is the final
// frame; drop discards the queue first, for a viewer that cannot keep up. It
// returns false, and takes nothing, when the viewer already stopped, a
// failed write included: the caller keeps last.
func (v *viewer) stop(last *frame, drop bool) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.stopped {
		return false
	}
	v.stopped = true
	v.last = last
	if drop {
		for _, f := range v.queue {
			v.queued -= len(f.payload)
		}
		v.queue = nil
	}
	if last != nil && last.typ != proto.TypeExit {
		v.conn.SetWriteDeadline(time.Now().Add(lastWriteTimeout))
	}
	v.signal()
	return true
}

func (v *viewer) signal() {
	select {
	case v.wake <- struct{}{}:
	default:
	}
}

// run writes queued frames until the viewer stops. A failed write ends only
// this viewer: it closes the connection, so the input loop sees it too.
func (v *viewer) run() {
	defer close(v.done)
	for {
		<-v.wake
		v.mu.Lock()
		batch, stopped, last := v.queue, v.stopped, v.last
		v.queue = nil
		v.mu.Unlock()
		for _, f := range batch {
			if v.w.Write(f.typ, f.payload) != nil {
				v.fail()
				return
			}
			if f.typ == proto.TypeStdout {
				v.written.Add(uint64(len(f.payload)))
			}
			v.mu.Lock()
			v.queued -= len(f.payload)
			v.mu.Unlock()
		}
		if !stopped {
			continue
		}
		v.finish(last)
		return
	}
}

// fail stops the viewer after a failed write and closes the connection, so
// the input loop ends too.
func (v *viewer) fail() {
	v.mu.Lock()
	v.stopped = true
	v.mu.Unlock()
	v.conn.Close()
}

// finish writes the last frame. After DETACHED the guest closes the
// connection; after EXIT it gives the host exitLinger to close first.
func (v *viewer) finish(last *frame) {
	if last == nil {
		return
	}
	if v.w.Write(last.typ, last.payload) != nil {
		v.conn.Close()
		return
	}
	if last.written != nil {
		last.written()
	}
	if last.typ != proto.TypeExit {
		v.conn.Close()
		return
	}
	v.conn.SetReadDeadline(time.Now().Add(exitLinger))
}

func mustJSON(value any) []byte {
	b, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return b
}
