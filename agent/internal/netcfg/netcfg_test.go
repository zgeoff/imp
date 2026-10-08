package netcfg

import (
	"errors"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/vishvananda/netlink"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

func TestParseAddrReadsAnAddressWithItsPrefixLength(t *testing.T) {
	for _, tc := range []struct {
		name string
		cidr string
	}{
		{name: "IPv4", cidr: "10.66.0.2/30"},
		{name: "IPv6", cidr: "fd12:3456:789a::a42:2/128"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			addr, err := parseAddr(tc.cidr)

			assert.NilError(t, err)
			assert.Equal(t, addr.IPNet.String(), tc.cidr)
		})
	}
}

func TestParseAddrRefusesAnythingButAnAddressWithAPrefix(t *testing.T) {
	for _, tc := range []struct {
		name string
		cidr string
	}{
		{name: "no prefix", cidr: "10.66.0.2"},
		{name: "octet out of range", cidr: "10.66.0.300/30"},
		{name: "not an address", cidr: "not-an-ip"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseAddr(tc.cidr)

			var parseErr *net.ParseError
			assert.Assert(t, errors.As(err, &parseErr), "err = %v, want a *net.ParseError", err)
		})
	}
}

func TestParseGatewayReadsAnAddressOrNoneForEmpty(t *testing.T) {
	for _, tc := range []struct {
		name string
		gw   string
		want net.IP
	}{
		{name: "IPv4", gw: "10.66.0.1", want: net.ParseIP("10.66.0.1")},
		{name: "IPv6 link-local", gw: "fe80::1", want: net.ParseIP("fe80::1")},
		{name: "empty means no default route", gw: "", want: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ip, err := parseGateway(tc.gw)

			assert.NilError(t, err)
			assert.DeepEqual(t, ip, tc.want)
		})
	}
}

func TestParseGatewayRefusesAnythingButABareAddress(t *testing.T) {
	for _, tc := range []struct {
		name string
		gw   string
	}{
		{name: "with a prefix", gw: "10.66.0.1/30"},
		{name: "a name", gw: "gateway"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseGateway(tc.gw)

			assert.ErrorContains(t, err, "not an IP")
		})
	}
}

func TestWriteResolvConfWritesOneNameserverLinePerServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resolv.conf")
	assert.NilError(t, os.WriteFile(path, []byte("nameserver 9.9.9.9\n"), 0o644))

	err := writeResolvConf(fsroot.Host, path, []string{"1.1.1.1", "8.8.8.8"})

	assert.NilError(t, err)
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	assert.Equal(t, string(b), "nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
}

func TestWriteResolvConfKeepsTheImagesFileWithoutServers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resolv.conf")
	assert.NilError(t, os.WriteFile(path, []byte("nameserver 9.9.9.9\n"), 0o644))

	err := writeResolvConf(fsroot.Host, path, nil)

	assert.NilError(t, err)
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	assert.Equal(t, string(b), "nameserver 9.9.9.9\n")
}

// Images often link resolv.conf into systemd-resolved's runtime dir, which
// nothing in an imp fills: the link becomes a plain file and its target stays.
func TestWriteResolvConfReplacesASymlinkWithAPlainFile(t *testing.T) {
	dir := t.TempDir()
	path, target := filepath.Join(dir, "resolv.conf"), filepath.Join(dir, "stub-resolv.conf")
	assert.NilError(t, os.WriteFile(target, []byte("nameserver 9.9.9.9\n"), 0o644))
	assert.NilError(t, os.Symlink(target, path))

	err := writeResolvConf(fsroot.Host, path, []string{"1.1.1.1"})

	assert.NilError(t, err)
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "nameserver 1.1.1.1\n"))
	fi, err := os.Lstat(path)
	assert.NilError(t, err)
	assert.Check(t, fi.Mode()&os.ModeSymlink == 0, "resolv.conf is still a symlink")
	b, err = os.ReadFile(target)
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "nameserver 9.9.9.9\n"), "the symlink target changed")
}

func TestWriteIPv6ConfWritesEachSettingUnderTheInterface(t *testing.T) {
	root := t.TempDir()
	assert.NilError(t, os.MkdirAll(filepath.Join(root, "eth0"), 0o755))

	err := writeIPv6Conf(root, "eth0", map[string]string{"accept_ra": "0"})

	assert.NilError(t, err)
	got, err := os.ReadFile(filepath.Join(root, "eth0", "accept_ra"))
	assert.NilError(t, err)
	assert.Equal(t, string(got), "0\n")
}

func TestWriteIPv6ConfFailsForAMissingInterface(t *testing.T) {
	root := t.TempDir()

	err := writeIPv6Conf(root, "nope", map[string]string{"accept_ra": "0"})

	assert.ErrorIs(t, err, fs.ErrNotExist)
}

func TestUp6WithoutAnAddressDoesNothing(t *testing.T) {
	err := Up6("no-such-link", "", "")

	assert.NilError(t, err)
}

// This runs against the host's real netlink: a fresh network namespace
// needs CAP_SYS_ADMIN, or a user namespace that a multi-threaded test binary
// cannot enter. Up6 looks the link up by name before it writes anything, so
// with no such link it fails at a read-only lookup. The test refuses to run
// if a link of that name exists, since Up6 would then configure it.
func TestUp6FailsForAMissingLink(t *testing.T) {
	_, err := netlink.LinkByName("no-such-link")
	var absent netlink.LinkNotFoundError
	assert.Assert(t, errors.As(err, &absent), "a link named no-such-link exists here (%v); refusing to configure it", err)

	err = Up6("no-such-link", "fd00::2/128", "fe80::1")

	var notFound netlink.LinkNotFoundError
	assert.Assert(t, errors.As(err, &notFound), "err = %v, want a netlink.LinkNotFoundError", err)
}
