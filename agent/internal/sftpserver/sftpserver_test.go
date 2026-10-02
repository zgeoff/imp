package sftpserver

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/pkg/sftp"
)

// pipe joins the client's writes to the server's reads, and back.
type pipe struct {
	io.Reader
	io.WriteCloser
}

func TestServesFilesRelativeToHome(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "in.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	toServer, fromClient := io.Pipe()
	toClient, fromServer := io.Pipe()
	served := make(chan error, 1)
	go func() {
		served <- Serve(pipe{toServer, fromServer}, home)
		fromServer.Close()
	}()

	client, err := sftp.NewClientPipe(toClient, fromClient)
	if err != nil {
		t.Fatal(err)
	}
	wd, err := client.Getwd()
	if err != nil || wd != home {
		t.Fatalf("working directory %q (%v), want %q", wd, err, home)
	}
	f, err := client.Open("in.txt")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(f)
	if err != nil || string(got) != "hello" {
		t.Fatalf("read %q (%v)", got, err)
	}
	f.Close()
	out, err := client.Create("out.txt")
	if err != nil {
		t.Fatal(err)
	}
	out.Write([]byte("back"))
	out.Close()
	client.Close()

	if err := <-served; err != nil {
		t.Fatalf("Serve: %v", err)
	}
	written, err := os.ReadFile(filepath.Join(home, "out.txt"))
	if err != nil || string(written) != "back" {
		t.Fatalf("out.txt %q (%v)", written, err)
	}
}
