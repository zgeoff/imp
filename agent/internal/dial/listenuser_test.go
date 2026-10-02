package dial

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// listenThroughHelper binds through the helper process, as the test's own
// user
func listenThroughHelper(t *testing.T, network, address string) (*Bound, error) {
	t.Helper()
	d := testDialer("")
	fds, err := d.runHelper(nil, []string{ListenCommand, network, address}, 2, proto.ErrListenFailed)
	if err != nil {
		return nil, err
	}
	b, err := wrapBound(fds, network, address)
	if err == nil {
		t.Cleanup(b.Close)
	}
	return b, err
}

func TestTheListenHelperBindsAUnixPathAndHandsItBack(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	path := filepath.Join(dir, "app.sock")

	b, err := listenThroughHelper(t, "unix", path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket %v, %v", info, err)
	}
	c, err := net.Dial("unix", "app.sock")
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if _, err := b.Listener.Accept(); err != nil {
		t.Fatal(err)
	}

	b.Close()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("the socket is still there: %v", err)
	}
}

func TestTheListenHelperBindsALoopbackPort(t *testing.T) {
	b, err := listenThroughHelper(t, "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if b.Port == 0 || b.Dir != -1 {
		t.Fatalf("got port %d, dir %d", b.Port, b.Dir)
	}
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", b.Port))
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}

// The directory is resolved before the check, so a symlink in the path
// cannot lead under the agent's own directory.
func TestAListenThroughASymlinkIntoImpDirIsRefused(t *testing.T) {
	dir := t.TempDir()
	old := impDir
	impDir = filepath.Join(dir, "imp")
	t.Cleanup(func() { impDir = old })
	if err := os.MkdirAll(filepath.Join(impDir, "ssh-agent"), 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(filepath.Join(impDir, "ssh-agent"), link); err != nil {
		t.Fatal(err)
	}

	_, err := bindSocket("unix", filepath.Join(link, "x.sock"))
	requireCode(t, err, proto.ErrBadRequest)
	_, err = bindSocket("unix", filepath.Join(impDir, "x.sock"))
	requireCode(t, err, proto.ErrBadRequest)
}

func TestAMissingDirectoryIsNamed(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no", "such")
	_, err := bindSocket("unix", filepath.Join(missing, "app.sock"))
	requireCode(t, err, proto.ErrBadRequest)
	if pe := err.(*proto.Error); pe.Message != fmt.Sprintf("the directory %s does not exist in the imp", missing) {
		t.Fatalf("message %q", pe.Message)
	}
}

// As root: the helper binds as the user, so a directory only root may write
// refuses the bind, the socket belongs to the user, and a port below 1024
// fails as it would for them.
func TestAListenRunsAsTheUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to change credentials")
	}
	const uid, gid = 4242, 4242
	dir, err := os.MkdirTemp("/tmp", "listen")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	open := filepath.Join(dir, "open")
	rootOnly := filepath.Join(dir, "root")
	for path, mode := range map[string]os.FileMode{dir: 0o755, open: 0o777, rootOnly: 0o755} {
		if err := os.MkdirAll(path, mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
	}

	helper := filepath.Join(dir, "helper")
	binary, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, binary, 0o755); err != nil {
		t.Fatal(err)
	}
	d := NewDialer(testReaper, "dev", helper)
	d.lookup = func(string) (*syscall.Credential, error) {
		return &syscall.Credential{Uid: uid, Gid: gid, Groups: []uint32{}}, nil
	}

	b, err := d.Listen("unix", filepath.Join(open, "app.sock"))
	if err != nil {
		t.Fatal(err)
	}
	var st syscall.Stat_t
	if err := syscall.Lstat(filepath.Join(open, "app.sock"), &st); err != nil || st.Uid != uid {
		t.Fatalf("the socket is uid %d, %v", st.Uid, err)
	}
	b.Close()

	_, err = d.Listen("unix", filepath.Join(rootOnly, "app.sock"))
	requireCode(t, err, proto.ErrListenFailed)
	// a container may let every user bind low ports
	start, _ := os.ReadFile("/proc/sys/net/ipv4/ip_unprivileged_port_start")
	if strings.TrimSpace(string(start)) != "0" {
		_, err = d.Listen("tcp", "127.0.0.1:80")
		requireCode(t, err, proto.ErrListenFailed)
	}
}
