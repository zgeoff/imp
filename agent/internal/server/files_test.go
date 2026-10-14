package server

import (
	"os"
	"path/filepath"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/files"
	"github.com/zgeoff/imp/agent/internal/proto"
)

func TestFilesWriteWritesTheFileAndAnswersOK(t *testing.T) {
	dir := t.TempDir()
	s := &Server{Files: files.New(dir)}

	resp := roundTrip(t, s, &proto.Request{Op: proto.OpFilesWrite, Path: new("notes/today.json"), Data: []byte(`{"title":"kettle"}`)})

	var ok proto.OK
	assert.NilError(t, proto.Unmarshal(resp, &ok), "reply %s", resp)
	assert.Check(t, ok.Ok)
	b, err := os.ReadFile(filepath.Join(dir, "notes/today.json"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), `{"title":"kettle"}`))
}

func TestFilesWriteRefusesABadPath(t *testing.T) {
	s := &Server{Files: files.New(t.TempDir())}

	resp := roundTrip(t, s, &proto.Request{Op: proto.OpFilesWrite, Path: new("../today.json"), Data: []byte("{}")})

	assert.Equal(t, errorCode(t, resp), proto.ErrBadRequest)
}

func TestFilesRemoveAnswersWhetherAFileWasRemoved(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, files.New(dir).Write("notes/today.json", []byte("{}")))
	s := &Server{Files: files.New(dir)}

	resp := roundTrip(t, s, &proto.Request{Op: proto.OpFilesRemove, Path: new("notes/today.json")})

	var removed proto.FilesRemoved
	assert.NilError(t, proto.Unmarshal(resp, &removed), "reply %s", resp)
	assert.Check(t, removed.Removed)
	_, err := os.Stat(filepath.Join(dir, "notes/today.json"))
	assert.Check(t, os.IsNotExist(err))
}
