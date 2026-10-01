package proto

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	if err := w.WriteJSON(TypeRequest, Request{Op: OpPing}); err != nil {
		t.Fatal(err)
	}
	if err := w.Write(TypeStdinEOF, nil); err != nil {
		t.Fatal(err)
	}
	if err := w.Write(TypeStdout, []byte("hello")); err != nil {
		t.Fatal(err)
	}

	want := []byte{1, 0, 0, 0, 13}
	if got := buf.Bytes()[:5]; !bytes.Equal(got, want) {
		t.Fatalf("header = %v, want %v", got, want)
	}

	r := NewReader(&buf)
	cases := []struct {
		typ     Type
		payload string
	}{{TypeRequest, `{"op":"ping"}`}, {TypeStdinEOF, ""}, {TypeStdout, "hello"}}
	for _, c := range cases {
		f, err := r.Next()
		if err != nil {
			t.Fatal(err)
		}
		if f.Type != c.typ || string(f.Payload) != c.payload {
			t.Fatalf("got %s %q, want %s %q", f.Type, f.Payload, c.typ, c.payload)
		}
	}
	if _, err := r.Next(); err != io.EOF {
		t.Fatalf("err = %v, want io.EOF", err)
	}
}

func TestSplitsLargePayload(t *testing.T) {
	var buf bytes.Buffer
	data := bytes.Repeat([]byte("x"), MaxPayload+10)
	if err := NewWriter(&buf).Write(TypeStdout, data); err != nil {
		t.Fatal(err)
	}
	r := NewReader(&buf)
	var got int
	for {
		f, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		got += len(f.Payload)
	}
	if got != len(data) {
		t.Fatalf("got %d bytes, want %d", got, len(data))
	}
}

func TestTooLarge(t *testing.T) {
	hdr := []byte{8, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(hdr[1:], MaxPayload+1)
	if _, err := NewReader(bytes.NewReader(hdr)).Next(); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}

func TestTruncated(t *testing.T) {
	for _, in := range [][]byte{{8, 0, 0}, {8, 0, 0, 0, 4, 'a'}} {
		_, err := NewReader(bytes.NewReader(in)).Next()
		if err == nil || err == io.EOF {
			t.Fatalf("input %v: err = %v, want truncation error", in, err)
		}
	}
}
