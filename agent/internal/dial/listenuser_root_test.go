//go:build root

// The tests that bind as the user, so they need root: run them with -tags root as root.

package dial

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/proto"
)

// As root: the helper binds as the user, so the socket belongs to the user.
func TestListenBindsAsTheUser(t *testing.T) {
	dir := rootListenDir(t)
	open := filepath.Join(dir, "open")
	assert.NilError(t, os.Mkdir(open, 0o777))
	assert.NilError(t, os.Chmod(open, 0o777))
	d := userListenDialer(t, dir)

	b, err := d.Listen("unix", filepath.Join(open, "app.sock"))

	assert.NilError(t, err)
	t.Cleanup(b.Close)
	var st syscall.Stat_t
	assert.NilError(t, syscall.Lstat(filepath.Join(open, "app.sock"), &st))
	assert.Check(t, cmp.Equal(st.Uid, uint32(4242)))
}

// As root: a directory only root may write refuses the user's bind.
func TestListenRefusesADirectoryOnlyRootMayWrite(t *testing.T) {
	dir := rootListenDir(t)
	rootOnly := filepath.Join(dir, "root")
	assert.NilError(t, os.Mkdir(rootOnly, 0o755))
	d := userListenDialer(t, dir)

	_, err := d.Listen("unix", filepath.Join(rootOnly, "app.sock"))

	assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrListenFailed))
}

// As root: a port below 1024 fails for the user as it would for them,
// unless the container lets every user bind low ports.
func TestListenRefusesAPrivilegedPort(t *testing.T) {
	start, err := os.ReadFile("/proc/sys/net/ipv4/ip_unprivileged_port_start")
	assert.NilError(t, err)
	if strings.TrimSpace(string(start)) == "0" {
		t.Skip("every user may bind low ports here")
	}
	d := userListenDialer(t, rootListenDir(t))

	_, err = d.Listen("tcp", "127.0.0.1:80")

	assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrListenFailed))
}

// rootListenDir is a short directory the user may enter.
func rootListenDir(t *testing.T) string {
	t.Helper()
	dir := shortDir(t)
	assert.NilError(t, os.Chmod(dir, 0o755))
	return dir
}

// userListenDialer binds as uid and gid 4242 with no supplementary groups,
// through a copy of the helper in dir.
func userListenDialer(t *testing.T, dir string) *Dialer {
	t.Helper()
	d := userDialer(t, dir)
	d.cred = &syscall.Credential{Uid: 4242, Gid: 4242, Groups: []uint32{}}
	return d
}
