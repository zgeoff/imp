// Package safe keeps a panic in one goroutine from killing the agent. The
// agent is PID 1: if it dies, the kernel panics and the imp is gone.
package safe

import (
	"log"
	"runtime/debug"
)

// Go runs f in a new goroutine. A panic in f is logged and then onPanic, if
// not nil, runs to clean up whatever f owned.
func Go(name string, f func(), onPanic func()) {
	go func() {
		defer Recover(name, onPanic)
		f()
	}()
}

// Call runs f in the current goroutine and recovers a panic in it the same
// way, so a long-lived loop can survive one bad iteration.
func Call(name string, f func()) {
	defer Recover(name, nil)
	f()
}

// Recover must be deferred directly: recover only works in the deferred call.
func Recover(name string, onPanic func()) {
	v := recover()
	if v == nil {
		return
	}
	log.Printf("%s: panic: %v\n%s", name, v, debug.Stack())
	if onPanic != nil {
		Call(name+" cleanup", onPanic)
	}
}
