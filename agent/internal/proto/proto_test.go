package proto

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestWriterFramesEachPayloadBehindATypeAndBigEndianLength(t *testing.T) {
	var buf bytes.Buffer

	err := NewWriter(&buf).WriteJSON(TypeRequest, Request{Op: OpPing})

	assert.NilError(t, err)
	assert.DeepEqual(t, buf.Bytes(), append([]byte{1, 0, 0, 0, 13}, `{"op":"ping"}`...))
}

func TestReaderReadsBackWhatTheWriterSentThenACleanEOF(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	assert.NilError(t, w.WriteJSON(TypeRequest, Request{Op: OpPing}))
	assert.NilError(t, w.Write(TypeStdinEOF, nil))
	assert.NilError(t, w.Write(TypeStdout, []byte("hello")))
	r := NewReader(&buf)

	var frames []Frame
	for range 3 {
		f, err := r.Next()
		assert.NilError(t, err)
		frames = append(frames, f)
	}
	_, err := r.Next()

	assert.Check(t, cmp.DeepEqual(frames, []Frame{
		{Type: TypeRequest, Payload: []byte(`{"op":"ping"}`)},
		{Type: TypeStdinEOF, Payload: []byte{}},
		{Type: TypeStdout, Payload: []byte("hello")},
	}))
	assert.Check(t, cmp.Equal(err, io.EOF))
}

func TestWriterSplitsAPayloadLargerThanMaxPayloadIntoFrames(t *testing.T) {
	var buf bytes.Buffer
	data := bytes.Repeat([]byte("x"), MaxPayload+10)
	assert.NilError(t, NewWriter(&buf).Write(TypeStdout, data))
	r := NewReader(&buf)

	var sizes []int
	var got []byte
	for {
		f, err := r.Next()
		if err == io.EOF {
			break
		}
		assert.NilError(t, err)
		sizes = append(sizes, len(f.Payload))
		got = append(got, f.Payload...)
	}

	assert.Check(t, cmp.DeepEqual(sizes, []int{MaxPayload, 10}))
	assert.Check(t, bytes.Equal(got, data), "the reassembled payload differs from what was sent")
}

func TestReaderRefusesAFrameLongerThanMaxPayload(t *testing.T) {
	hdr := []byte{8, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(hdr[1:], MaxPayload+1)

	_, err := NewReader(bytes.NewReader(hdr)).Next()

	assert.ErrorIs(t, err, ErrTooLarge)
}

func TestReaderReportsATruncatedFrameAsAnUnexpectedEOF(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []byte
	}{
		{name: "header", in: []byte{8, 0, 0}},
		{name: "payload", in: []byte{8, 0, 0, 0, 4, 'a'}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewReader(bytes.NewReader(tc.in)).Next()

			assert.ErrorIs(t, err, io.ErrUnexpectedEOF)
		})
	}
}
