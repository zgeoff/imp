//go:build root

// The tests that change credentials, so they need root: run them with -tags root as root.

package dial

import (
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/imagecfg"
	"github.com/zgeoff/impz/agent/internal/proc"
	"github.com/zgeoff/impz/agent/internal/proto"
)

// The uid, gid and supplementary group the user's helper runs with, as
// root sets them.
const userUID, userGID, dockerGID = 4242, 4242, 4343

// userDialer dials as the user, through a copy of the helper in dir.
func userDialer(t *testing.T, dir string) *Dialer {
	t.Helper()
	d := NewDialer(&proc.Direct{Reaper: testReaper, Agent: helperCopy(t, dir)}, imagecfg.NewLive(imagecfg.Config{User: "dev"}))
	d.cred = &syscall.Credential{Uid: userUID, Gid: userGID, Groups: []uint32{dockerGID}}
	return d
}

// As root: the helper takes the user's uid, gid and supplementary groups,
// and the server sees the user in SO_PEERCRED.
func TestOpenUnixConnectsAsTheUser(t *testing.T) {
	for _, tc := range []struct {
		name     string
		uid, gid int
		mode     os.FileMode
	}{
		{name: "the user's own socket", uid: userUID, gid: userGID, mode: 0o600},
		{name: "a socket of a supplementary group", uid: 0, gid: dockerGID, mode: 0o660},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := shortDir(t)
			assert.NilError(t, os.Chmod(dir, 0o755))
			peer := listenPeer(t, dir, "target.sock", tc.uid, tc.gid, tc.mode)
			d := userDialer(t, dir)

			c, err := d.openUnix(peer.path)

			assert.NilError(t, err)
			assert.NilError(t, c.Close())
			assert.Check(t, cmp.Equal(<-peer.peerUID, uint32(userUID)), "the uid the server saw")
		})
	}
}

// As root: the helper connects with the user's rights, so a socket the user
// cannot reach fails the dial.
func TestOpenUnixRefusesASocketTheUserCannotReach(t *testing.T) {
	for _, tc := range []struct {
		name string
		// socket makes the target under dir and returns its path
		socket func(t *testing.T, dir string) string
	}{
		{name: "a socket only root may use", socket: func(t *testing.T, dir string) string {
			return listenPeer(t, dir, "root.sock", 0, 0, 0o600).path
		}},
		{name: "an open socket in a directory only root may enter", socket: func(t *testing.T, dir string) string {
			hidden := filepath.Join(dir, "hidden")
			assert.NilError(t, os.Mkdir(hidden, 0o700))
			return listenPeer(t, hidden, "open.sock", 0, 0, 0o666).path
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := shortDir(t)
			assert.NilError(t, os.Chmod(dir, 0o755))
			path := tc.socket(t, dir)
			d := userDialer(t, dir)

			_, err := d.openUnix(path)

			assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrDialFailed))
		})
	}
}

// helperCopy copies the test binary, which is also the helper, into dir:
// the user cannot run it where go test built it.
func helperCopy(t *testing.T, dir string) string {
	t.Helper()
	helper := filepath.Join(dir, "helper")
	binary, err := os.ReadFile(os.Args[0])
	assert.NilError(t, err)
	assert.NilError(t, os.WriteFile(helper, binary, 0o755))
	return helper
}

type peerListener struct {
	path    string
	peerUID chan uint32
}

// listenPeer listens on dir/name, owned by uid:gid with mode, and reports
// the uid of each client from SO_PEERCRED.
func listenPeer(t *testing.T, dir, name string, uid, gid int, mode os.FileMode) *peerListener {
	t.Helper()
	path := filepath.Join(dir, name)
	l, err := net.Listen("unix", path)
	assert.NilError(t, err)
	stop := make(chan struct{})
	assert.NilError(t, os.Chown(path, uid, gid))
	assert.NilError(t, os.Chmod(path, mode))
	p := &peerListener{path: path, peerUID: make(chan uint32, 1)}
	serveConns(t, l, func(c net.Conn) {
		raw, err := c.(*net.UnixConn).SyscallConn()
		if err != nil {
			return
		}
		var uid uint32
		var credErr error
		raw.Control(func(fd uintptr) {
			var cred *unix.Ucred
			cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
			if credErr == nil {
				uid = cred.Uid
			}
		})
		if credErr != nil {
			return
		}
		select {
		case p.peerUID <- uid:
		case <-stop:
		}
	})
	// registered after serveConns, so it runs first and frees a handler
	// blocked on the report before serveConns waits for it
	t.Cleanup(func() { close(stop) })
	return p
}
