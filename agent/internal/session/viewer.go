package session

import (
	"encoding/json"
	"net"
	"sync"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// maxQueued bounds the bytes a viewer may have waiting to be written. A
// viewer that falls this far behind is dropped, so a slow host connection
// never holds up the pty and the program behind it.
const maxQueued = 2 << 20

// exitLinger bounds how long a connection waits for the host to close after
// EXIT, as in exec: a host frame that races the exit must not hit a closed
// socket.
const exitLinger = 2 * time.Second

type frame struct {
	typ     proto.Type
	payload []byte
}

// viewer is one attached connection. The session queues frames for it
// without blocking; the viewer's own goroutine writes them out.
type viewer struct {
	conn net.Conn
	w    *proto.Writer

	mu     sync.Mutex
	queue  []frame
	queued int
	// last, once set, is written after the queue; then the viewer stops.
	last    *frame
	stopped bool
	wake    chan struct{}

	// done closes when the writer has stopped.
	done chan struct{}
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
	return v.push(frame{typ, mustJSON(value)})
}

// stop ends the viewer once the queue is out. last, if not nil, is the final
// frame; drop discards the queue first, for a viewer that cannot keep up.
func (v *viewer) stop(last *frame, drop bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.stopped {
		return
	}
	v.stopped = true
	v.last = last
	if drop {
		v.queue, v.queued = nil, 0
	}
	v.signal()
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
		v.queue, v.queued = nil, 0
		v.mu.Unlock()
		for _, f := range batch {
			if v.w.Write(f.typ, f.payload) != nil {
				v.conn.Close()
				return
			}
		}
		if !stopped {
			continue
		}
		v.finish(last)
		return
	}
}

// finish writes the last frame. After DETACHED the guest closes the
// connection; after EXIT it gives the host exitLinger to close first.
func (v *viewer) finish(last *frame) {
	if last == nil {
		return
	}
	if v.w.Write(last.typ, last.payload) != nil || last.typ != proto.TypeExit {
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
