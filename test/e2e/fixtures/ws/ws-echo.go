// ws-echo is the WebSocket peer for the e2e harness. Plain HTTP gets
// "e2e-ws-ok". A WebSocket gets "hello" the moment it opens, then every text
// or binary message back prefixed with "echo ". The text message
// "close <code> <reason>" makes the server close with that code and reason,
// and the code and reason of a close the client starts are written to
// /tmp/ws-last-close. It implements just enough of RFC 6455, with no
// dependencies, so the fixture builds without fetching modules.
package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
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

const lastCloseFile = "/tmp/ws-last-close"

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
	head := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n"
	// agree to the first subprotocol the client offers
	if offered := r.Header.Get("Sec-WebSocket-Protocol"); offered != "" {
		head += "Sec-WebSocket-Protocol: " + strings.TrimSpace(strings.Split(offered, ",")[0]) + "\r\n"
	}
	_, _ = rw.WriteString(head + "\r\n")
	if err := rw.Flush(); err != nil {
		return
	}
	// sent before the client says anything: the proxy must buffer it
	if err := writeFrame(rw, opText, []byte("hello")); err != nil {
		return
	}
	if err := echo(rw); err != nil && !errors.Is(err, io.EOF) {
		log.Printf("websocket: %v", err)
	}
}

// echo answers frames until the connection closes. Messages are single
// frames: the harness never fragments.
func echo(rw *bufio.ReadWriter) error {
	for {
		op, payload, err := readFrame(rw.Reader)
		if err != nil {
			return err
		}
		switch op {
		case opText:
			if code, reason, ok := parseCloseRequest(string(payload)); ok {
				return closeWith(rw, code, reason)
			}
			err = writeFrame(rw, opText, append([]byte("echo "), payload...))
		case opBinary:
			err = writeFrame(rw, opBinary, append([]byte("echo "), payload...))
		case opPing:
			err = writeFrame(rw, opPong, payload)
		case opClose:
			recordClose(payload)
			return writeFrame(rw, opClose, payload)
		}
		if err != nil {
			return err
		}
	}
}

// parseCloseRequest reads "close <code> <reason>".
func parseCloseRequest(message string) (uint16, string, bool) {
	fields := strings.SplitN(message, " ", 3)
	if len(fields) != 3 || fields[0] != "close" {
		return 0, "", false
	}
	code, err := strconv.ParseUint(fields[1], 10, 16)
	if err != nil {
		return 0, "", false
	}
	return uint16(code), fields[2], true
}

// closeWith starts the close handshake and waits for the client's reply.
func closeWith(rw *bufio.ReadWriter, code uint16, reason string) error {
	payload := binary.BigEndian.AppendUint16(nil, code)
	if err := writeFrame(rw, opClose, append(payload, reason...)); err != nil {
		return err
	}
	for {
		op, _, err := readFrame(rw.Reader)
		if err != nil || op == opClose {
			return err
		}
	}
}

func recordClose(payload []byte) {
	text := "none"
	if len(payload) >= 2 {
		text = fmt.Sprintf("%d %s", binary.BigEndian.Uint16(payload), payload[2:])
	}
	if err := os.WriteFile(lastCloseFile, []byte(text+"\n"), 0o644); err != nil {
		log.Printf("record close: %v", err)
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
