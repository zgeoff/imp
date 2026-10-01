// ws-echo answers plain HTTP with "e2e-ws-ok" and echoes every WebSocket
// text or binary message back prefixed with "echo ". It implements just
// enough of RFC 6455 for the e2e harness, with no dependencies, so the
// fixture builds without fetching modules.
package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
)

const acceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	opText   = 0x1
	opBinary = 0x2
	opClose  = 0x8
	opPing   = 0x9
	opPong   = 0xa
)

func main() {
	http.HandleFunc("/", serve)
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func serve(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		_, _ = io.WriteString(w, "e2e-ws-ok\n")
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}
	conn, rw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		log.Printf("hijack: %v", err)
		return
	}
	defer conn.Close()

	sum := sha1.Sum([]byte(key + acceptGUID))
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n")
	if err := rw.Flush(); err != nil {
		return
	}
	if err := echo(rw); err != nil && !errors.Is(err, io.EOF) {
		log.Printf("websocket: %v", err)
	}
}

// echo answers frames until the client closes. Messages are single frames:
// the harness never fragments.
func echo(rw *bufio.ReadWriter) error {
	for {
		op, payload, err := readFrame(rw.Reader)
		if err != nil {
			return err
		}
		switch op {
		case opText, opBinary:
			err = writeFrame(rw, op, append([]byte("echo "), payload...))
		case opPing:
			err = writeFrame(rw, opPong, payload)
		case opClose:
			return writeFrame(rw, opClose, payload)
		}
		if err != nil {
			return err
		}
	}
}

func readFrame(r *bufio.Reader) (byte, []byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	op := head[0] & 0x0f
	size := uint64(head[1] & 0x7f)
	switch size {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		size = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		size = binary.BigEndian.Uint64(ext[:])
	}
	if size > 1<<20 {
		return 0, nil, errors.New("frame over 1 MiB")
	}
	var mask [4]byte
	masked := head[1]&0x80 != 0
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return op, payload, nil
}

// writeFrame sends one unmasked final frame, as a server must.
func writeFrame(rw *bufio.ReadWriter, op byte, payload []byte) error {
	head := []byte{0x80 | op}
	switch n := len(payload); {
	case n < 126:
		head = append(head, byte(n))
	case n <= 0xffff:
		head = append(head, 126)
		head = binary.BigEndian.AppendUint16(head, uint16(n))
	default:
		head = append(head, 127)
		head = binary.BigEndian.AppendUint64(head, uint64(n))
	}
	if _, err := rw.Write(head); err != nil {
		return err
	}
	if _, err := rw.Write(payload); err != nil {
		return err
	}
	return rw.Flush()
}
