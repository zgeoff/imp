package sftpserver

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/pkg/sftp"
	"gotest.tools/v3/assert"
)

// pipe joins the client's writes to the server's reads, and back.
type pipe struct {
	io.Reader
	io.WriteCloser
}

// startSession serves one SFTP session at home over in-process pipes and
// returns its client. Cleanup closes the client, waits for Serve to return,
// and checks that it ended cleanly.
func startSession(t *testing.T, home string) *sftp.Client {
	t.Helper()
	toServer, fromClient := io.Pipe()
	toClient, fromServer := io.Pipe()
	served := make(chan error, 1)
	go func() {
		served <- Serve(pipe{toServer, fromServer}, home)
		fromServer.Close()
	}()
	client, err := sftp.NewClientPipe(toClient, fromClient)
	assert.NilError(t, err)
	t.Cleanup(func() {
		client.Close()
		assert.Check(t, <-served, "Serve")
	})
	return client
}

func TestServeStartsTheSessionInHome(t *testing.T) {
	home := t.TempDir()
	client := startSession(t, home)

	wd, err := client.Getwd()

	assert.NilError(t, err)
	assert.Equal(t, wd, home)
}

func TestServeReadsARelativePathFromHome(t *testing.T) {
	home := t.TempDir()
	assert.NilError(t, os.WriteFile(filepath.Join(home, "in.txt"), []byte("hello"), 0o644))
	client := startSession(t, home)

	f, err := client.Open("in.txt")

	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })
	got, err := io.ReadAll(f)
	assert.NilError(t, err)
	assert.Equal(t, string(got), "hello")
}

func TestServeWritesARelativePathUnderHome(t *testing.T) {
	home := t.TempDir()
	client := startSession(t, home)

	out, err := client.Create("out.txt")

	assert.NilError(t, err)
	_, err = out.Write([]byte("back"))
	assert.NilError(t, err)
	assert.NilError(t, out.Close())
	written, err := os.ReadFile(filepath.Join(home, "out.txt"))
	assert.NilError(t, err)
	assert.Equal(t, string(written), "back")
}

// A home that is not a directory is ignored, as with no home at all: the
// session starts where the server's process is.
func TestServeIgnoresAHomeThatIsNotADirectory(t *testing.T) {
	cwd, err := os.Getwd()
	assert.NilError(t, err)
	file := filepath.Join(t.TempDir(), "file")
	assert.NilError(t, os.WriteFile(file, nil, 0o644))
	client := startSession(t, file)

	wd, err := client.Getwd()

	assert.NilError(t, err)
	assert.Equal(t, wd, cwd)
}
