package dial

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// listenThroughHelper binds through the helper process, as the test's own
// user.
func listenThroughHelper(t *testing.T, network, address string) *Bound {
	t.Helper()
	d := testDialer("")
	fds, err := d.runHelper([]string{ListenCommand, network, address}, 2, proto.ErrListenFailed)
	assert.NilError(t, err)
	b, err := wrapBound(fds, network, address)
	assert.NilError(t, err)
	t.Cleanup(b.Close)
	return b
}

func TestTheListenHelperBindsAUnixPathAsTheUsersSocket(t *testing.T) {
	t.Parallel()
	path := filepath.Join(shortDir(t), "app.sock")

	listenThroughHelper(t, "unix", path)

	info, err := os.Lstat(path)
	assert.NilError(t, err)
	assert.Check(t, info.Mode()&os.ModeSocket != 0, "mode %s is no socket", info.Mode())
	assert.Check(t, cmp.Equal(info.Mode().Perm(), os.FileMode(0o600)))
}

func TestTheListenHelperHandsBackAUnixListenerThatAccepts(t *testing.T) {
	t.Parallel()
	path := filepath.Join(shortDir(t), "app.sock")
	b := listenThroughHelper(t, "unix", path)
	c, err := net.Dial("unix", path)
	assert.NilError(t, err)
	t.Cleanup(func() { c.Close() })

	accepted, err := b.Listener.Accept()

	assert.NilError(t, err)
	assert.NilError(t, accepted.Close())
}

func TestBoundCloseRemovesTheUnixSocket(t *testing.T) {
	t.Parallel()
	path := filepath.Join(shortDir(t), "app.sock")
	b := listenThroughHelper(t, "unix", path)

	b.Close()

	_, err := os.Lstat(path)
	assert.Check(t, cmp.ErrorIs(err, os.ErrNotExist))
}

func TestTheListenHelperBindsALoopbackPort(t *testing.T) {
	t.Parallel()

	b := listenThroughHelper(t, "tcp", "127.0.0.1:0")

	assert.Check(t, b.Port != 0, "no port")
	assert.Check(t, cmp.Equal(b.Dir, -1))
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", b.Port))
	assert.NilError(t, err)
	assert.NilError(t, c.Close())
}

func TestCheckListenAddressAcceptsAnAbsoluteUnixPathOrALoopbackPort(t *testing.T) {
	for _, tc := range []struct {
		network, address string
	}{
		{network: "unix", address: "/run/app.sock"},
		{network: "tcp", address: "127.0.0.1:0"},
		{network: "tcp", address: "127.0.0.1:65535"},
	} {
		t.Run(tc.network+" "+tc.address, func(t *testing.T) {
			assert.Check(t, checkListenAddress(tc.network, tc.address))
		})
	}
}

func TestCheckListenAddressRefusesABadAddress(t *testing.T) {
	for _, tc := range []struct {
		name, network, address string
	}{
		{name: "a relative unix path", network: "unix", address: "app.sock"},
		{name: "an abstract socket", network: "unix", address: "@app"},
		{name: "a unix path with no name", network: "unix", address: "/"},
		{name: "every interface", network: "tcp", address: "0.0.0.0:80"},
		{name: "a port out of range", network: "tcp", address: "127.0.0.1:70000"},
		{name: "no port", network: "tcp", address: "127.0.0.1"},
		{name: "udp", network: "udp", address: "127.0.0.1:53"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := checkListenAddress(tc.network, tc.address)

			assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrBadRequest))
		})
	}
}

// The directory is resolved before the check, so a symlink in the path
// cannot lead under the agent's own directory.
func TestBindSocketRefusesAPathUnderTheAgentsDirectory(t *testing.T) {
	dir := shortDir(t)
	old := impDir
	impDir = filepath.Join(dir, "imp")
	t.Cleanup(func() { impDir = old })
	assert.NilError(t, os.MkdirAll(filepath.Join(impDir, "ssh-agent"), 0o700))
	link := filepath.Join(dir, "link")
	assert.NilError(t, os.Symlink(filepath.Join(impDir, "ssh-agent"), link))
	for _, tc := range []struct {
		name, path string
	}{
		{name: "through a symlink", path: filepath.Join(link, "x.sock")},
		{name: "directly", path: filepath.Join(impDir, "x.sock")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := bindSocket("unix", tc.path)

			assert.Check(t, cmp.Equal(codeOf(t, err), proto.ErrBadRequest))
		})
	}
}

func TestBindSocketNamesAMissingDirectory(t *testing.T) {
	t.Parallel()
	missing := filepath.Join(t.TempDir(), "no", "such")

	_, err := bindSocket("unix", filepath.Join(missing, "app.sock"))

	var pe *proto.Error
	assert.Assert(t, errors.As(err, &pe), "got %v, want a protocol error", err)
	assert.Check(t, cmp.Equal(pe.Code, proto.ErrBadRequest))
	assert.Check(t, cmp.Equal(pe.Message, fmt.Sprintf("the directory %s does not exist in the imp", missing)))
}
