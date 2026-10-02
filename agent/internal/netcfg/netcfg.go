// Package netcfg configures guest networking: loopback, eth0, the default
// route and /etc/resolv.conf.
package netcfg

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

// Up brings lo up and, if cidr is set, gives iface the address and a
// default route through gw.
func Up(iface, cidr, gw string) error {
	lo, err := netlink.LinkByName("lo")
	if err != nil {
		return fmt.Errorf("lo: %w", err)
	}
	if err := netlink.LinkSetUp(lo); err != nil {
		return fmt.Errorf("lo up: %w", err)
	}
	if cidr == "" {
		return nil
	}

	link, err := netlink.LinkByName(iface)
	if err != nil {
		return fmt.Errorf("%s: %w", iface, err)
	}
	addr, err := parseAddr(cidr)
	if err != nil {
		return err
	}
	// Replace, not Add: a cold boot of a restored disk must not fail on EEXIST.
	if err := netlink.AddrReplace(link, addr); err != nil {
		return fmt.Errorf("%s addr: %w", iface, err)
	}
	if err := netlink.LinkSetUp(link); err != nil {
		return fmt.Errorf("%s up: %w", iface, err)
	}
	// a bad gateway still leaves the address up: the host can reach the guest
	gwIP, err := parseGateway(gw)
	if err != nil {
		return err
	}
	if gwIP == nil {
		return nil
	}
	route := &netlink.Route{LinkIndex: link.Attrs().Index, Gw: gwIP}
	if err := netlink.RouteReplace(route); err != nil {
		return fmt.Errorf("default route: %w", err)
	}
	return nil
}

// Up6 gives iface the IPv6 /128 in cidr and a default route through the
// link-local gw; nothing when cidr is empty. The address skips DAD: the
// host routed it to this tap alone. Router advertisements and redirects
// are off, so only the host's static route counts.
func Up6(iface, cidr, gw string) error {
	if cidr == "" {
		return nil
	}
	link, err := netlink.LinkByName(iface)
	if err != nil {
		return fmt.Errorf("%s: %w", iface, err)
	}
	if err := writeIPv6Conf(procSysIPv6, iface, map[string]string{
		"disable_ipv6":     "0",
		"accept_ra":        "0",
		"accept_redirects": "0",
	}); err != nil {
		return err
	}
	addr, err := parseAddr(cidr)
	if err != nil {
		return err
	}
	addr.Flags = unix.IFA_F_NODAD
	if err := netlink.AddrReplace(link, addr); err != nil {
		return fmt.Errorf("%s addr6: %w", iface, err)
	}
	gwIP, err := parseGateway(gw)
	if err != nil || gwIP == nil {
		return err
	}
	_, anyIPv6, _ := net.ParseCIDR("::/0")
	route := &netlink.Route{LinkIndex: link.Attrs().Index, Dst: anyIPv6, Gw: gwIP}
	if err := netlink.RouteReplace(route); err != nil {
		return fmt.Errorf("default route (IPv6): %w", err)
	}
	return nil
}

// procSysIPv6 is where the kernel keeps per-interface IPv6 settings.
const procSysIPv6 = "/proc/sys/net/ipv6/conf"

// writeIPv6Conf writes each setting of iface under root.
func writeIPv6Conf(root, iface string, settings map[string]string) error {
	for key, val := range settings {
		path := filepath.Join(root, iface, key)
		if err := os.WriteFile(path, []byte(val+"\n"), 0o644); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
	}
	return nil
}

// parseAddr reads imp.ip or imp.ip6, an address with its prefix length.
func parseAddr(cidr string) (*netlink.Addr, error) {
	addr, err := netlink.ParseAddr(cidr)
	if err != nil {
		return nil, fmt.Errorf("imp.ip %q: %w", cidr, err)
	}
	return addr, nil
}

// parseGateway reads imp.gw or imp.gw6; an empty one means no default route.
func parseGateway(gw string) (net.IP, error) {
	if gw == "" {
		return nil, nil
	}
	ip := net.ParseIP(gw)
	if ip == nil {
		return nil, fmt.Errorf("imp.gw %q: not an IP", gw)
	}
	return ip, nil
}

// WriteResolvConf writes nameservers to /etc/resolv.conf. Images often ship
// it as a symlink into systemd-resolved's runtime dir, which nothing in an
// imp populates, so a symlink is replaced by a plain file.
func WriteResolvConf(servers []string) error {
	return writeResolvConf("/etc/resolv.conf", servers)
}

func writeResolvConf(path string, servers []string) error {
	if len(servers) == 0 {
		return nil
	}
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return os.WriteFile(path, []byte(resolvConf(servers)), 0o644)
}

func resolvConf(servers []string) string {
	var b strings.Builder
	for _, s := range servers {
		fmt.Fprintf(&b, "nameserver %s\n", s)
	}
	return b.String()
}
