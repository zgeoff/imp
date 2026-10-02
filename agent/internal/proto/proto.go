// Package proto implements the imp agent wire protocol. See docs/architecture/protocol.md.
//
// A frame is [u8 type][u32 big-endian length][payload].
package proto

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// Type is a frame type. The numbers are part of the wire format.
type Type uint8

const (
	TypeRequest  Type = 1  // host→guest, JSON Request; always the first frame
	TypeResponse Type = 2  // guest→host, JSON; the reply to a unary request or a failed exec
	TypeStdin    Type = 3  // host→guest, raw bytes
	TypeStdinEOF Type = 4  // host→guest, empty
	TypeResize   Type = 5  // host→guest, JSON Resize
	TypeSignal   Type = 6  // host→guest, JSON Signal
	TypeStarted  Type = 7  // guest→host, JSON Started
	TypeStdout   Type = 8  // guest→host, raw bytes
	TypeStderr   Type = 9  // guest→host, raw bytes
	TypeExit     Type = 10 // guest→host, JSON Exit; the last frame
	TypeDetached Type = 11 // guest→host, JSON Detached; the last frame of a session connection
)

func (t Type) String() string {
	names := [...]string{"", "REQUEST", "RESPONSE", "STDIN", "STDIN_EOF", "RESIZE",
		"SIGNAL", "STARTED", "STDOUT", "STDERR", "EXIT", "DETACHED"}
	if int(t) < len(names) && names[t] != "" {
		return names[t]
	}
	return fmt.Sprintf("Type(%d)", uint8(t))
}

// MaxPayload bounds a single frame. Senders split larger data.
const MaxPayload = 1 << 20

// ErrTooLarge is returned for a frame whose length exceeds MaxPayload.
var ErrTooLarge = errors.New("proto: frame too large")

// Frame is one decoded frame.
type Frame struct {
	Type    Type
	Payload []byte
}

// Reader decodes frames from a stream.
type Reader struct{ r *bufio.Reader }

func NewReader(r io.Reader) *Reader { return &Reader{r: bufio.NewReader(r)} }

// Next reads one frame. It returns io.EOF only on a clean frame boundary.
func (r *Reader) Next() (Frame, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r.r, hdr[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return Frame{}, fmt.Errorf("proto: truncated header: %w", err)
		}
		return Frame{}, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > MaxPayload {
		return Frame{}, ErrTooLarge
	}
	f := Frame{Type: Type(hdr[0]), Payload: make([]byte, n)}
	if _, err := io.ReadFull(r.r, f.Payload); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return Frame{}, fmt.Errorf("proto: truncated %s payload: %w", f.Type, err)
	}
	return f, nil
}

// Writer encodes frames. It is safe for concurrent use, so stdout and
// stderr pumps can share one connection.
type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

// Write sends one frame, splitting payloads larger than MaxPayload.
func (w *Writer) Write(t Type, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	for {
		chunk := payload
		if len(chunk) > MaxPayload {
			chunk = chunk[:MaxPayload]
		}
		buf := make([]byte, 5+len(chunk))
		buf[0] = byte(t)
		binary.BigEndian.PutUint32(buf[1:], uint32(len(chunk)))
		copy(buf[5:], chunk)
		if _, err := w.w.Write(buf); err != nil {
			return err
		}
		payload = payload[len(chunk):]
		if len(payload) == 0 {
			return nil
		}
	}
}

// WriteJSON marshals v and sends it as one frame.
func (w *Writer) WriteJSON(t Type, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return w.Write(t, b)
}
