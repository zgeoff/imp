// Package netcfg configures guest networking: loopback, eth0, the default
// route and /etc/resolv.conf.
package netcfg

import (
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/vishvananda/netlink"
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
	addr, err := netlink.ParseAddr(cidr)
	if err != nil {
		return fmt.Errorf("imp.ip %q: %w", cidr, err)
	}
	// Replace, not Add: a cold boot of a restored disk must not fail on EEXIST.
	if err := netlink.AddrReplace(link, addr); err != nil {
		return fmt.Errorf("%s addr: %w", iface, err)
	}
	if err := netlink.LinkSetUp(link); err != nil {
		return fmt.Errorf("%s up: %w", iface, err)
	}
	if gw == "" {
		return nil
	}
	gwIP := net.ParseIP(gw)
	if gwIP == nil {
		return fmt.Errorf("imp.gw %q: not an IP", gw)
	}
	route := &netlink.Route{LinkIndex: link.Attrs().Index, Gw: gwIP}
	if err := netlink.RouteReplace(route); err != nil {
		return fmt.Errorf("default route: %w", err)
	}
	return nil
}

// WriteResolvConf writes nameservers to /etc/resolv.conf. Images often ship
// it as a symlink into systemd-resolved's runtime dir, which nothing in an
// imp populates, so a symlink is replaced by a plain file.
func WriteResolvConf(servers []string) error {
	if len(servers) == 0 {
		return nil
	}
	const path = "/etc/resolv.conf"
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	var b strings.Builder
	for _, s := range servers {
		fmt.Fprintf(&b, "nameserver %s\n", s)
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}
