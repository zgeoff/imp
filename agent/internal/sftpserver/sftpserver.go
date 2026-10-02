// Package sftpserver serves SFTP on stdin and stdout. impd's SSH gateway runs
// `/run/imp/sys/imp-agent sftp` from the system drive as an exec, so every
// image gets SFTP, with or without an sftp-server of its own.
package sftpserver

import (
	"errors"
	"io"
	"os"

	"github.com/pkg/sftp"
)

// stdio is the SFTP stream: requests on stdin, replies on stdout.
type stdio struct{}

func (stdio) Read(p []byte) (int, error)  { return os.Stdin.Read(p) }
func (stdio) Write(p []byte) (int, error) { return os.Stdout.Write(p) }

func (stdio) Close() error {
	return errors.Join(os.Stdin.Close(), os.Stdout.Close())
}

// Run serves one SFTP session on stdio until the client closes it. Relative
// paths start at $HOME, as with OpenSSH's sftp-server.
func Run() error {
	return Serve(stdio{}, os.Getenv("HOME"))
}

// Serve serves one SFTP session on rwc. Relative paths start at home, when
// it is a directory.
func Serve(rwc io.ReadWriteCloser, home string) error {
	var options []sftp.ServerOption
	if home != "" {
		if info, err := os.Stat(home); err == nil && info.IsDir() {
			options = append(options, sftp.WithServerWorkingDirectory(home))
		}
	}
	server, err := sftp.NewServer(rwc, options...)
	if err != nil {
		return err
	}
	if err := server.Serve(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}
