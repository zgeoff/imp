// ra-send sends router advertisements out of an interface to all nodes
// (ff02::1): a default route for 30 minutes and an autoconfigured /64. The
// ipv6 suite runs it in a guest to check its host ignores them. It uses a
// raw socket and no dependencies; the kernel fills in the checksum.
package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"syscall"
)

const (
	typeRouterAdvert = 134
	optPrefixInfo    = 3

	// on-link and autonomous
	prefixFlags = 0xc0
	hopLimit    = 255
	sends       = 3
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ra-send:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: ra-send <interface> <prefix>/64")
	}

	iface, err := net.InterfaceByName(args[0])
	if err != nil {
		return err
	}

	_, prefix, err := net.ParseCIDR(args[1])
	if err != nil {
		return err
	}

	fd, err := syscall.Socket(syscall.AF_INET6, syscall.SOCK_RAW, syscall.IPPROTO_ICMPV6)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)

	// NDP messages count only with a hop limit of 255 (RFC 4861)
	for _, opt := range []int{syscall.IPV6_MULTICAST_HOPS, syscall.IPV6_UNICAST_HOPS} {
		if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_IPV6, opt, hopLimit); err != nil {
			return err
		}
	}
	if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_IPV6, syscall.IPV6_MULTICAST_IF, iface.Index); err != nil {
		return err
	}

	to := &syscall.SockaddrInet6{ZoneId: uint32(iface.Index)}
	copy(to.Addr[:], net.ParseIP("ff02::1"))

	advert := buildAdvert(prefix.IP.To16())
	for range sends {
		if err := syscall.Sendto(fd, advert, 0, to); err != nil {
			return err
		}
	}
	return nil
}

// buildAdvert lays out RFC 4861 4.2 with one prefix information option (4.6.2).
func buildAdvert(prefix net.IP) []byte {
	advert := make([]byte, 16+32)
	advert[0] = typeRouterAdvert
	advert[4] = 64
	binary.BigEndian.PutUint16(advert[6:], 1800)

	option := advert[16:]
	option[0] = optPrefixInfo
	option[1] = 4
	option[2] = 64
	option[3] = prefixFlags
	binary.BigEndian.PutUint32(option[4:], 86400)
	binary.BigEndian.PutUint32(option[8:], 14400)
	copy(option[16:], prefix)
	return advert
}
