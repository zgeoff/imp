package server

import (
	"bufio"
	"encoding/hex"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/zgeoff/imp/agent/internal/proto"
)

func (s *Server) activity() (proto.Activity, error) {
	n := 0
	for _, p := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		c, err := countEstablished(p)
		if err != nil && !os.IsNotExist(err) {
			return proto.Activity{}, err
		}
		n += c
	}
	return proto.Activity{TCPEstablished: n, ExecSessions: s.Exec.Active(), Load1: load1()}, nil
}

// countEstablished counts ESTABLISHED sockets in a /proc/net/tcp{,6} table,
// skipping loopback ones. The agent's own vsock connections are AF_VSOCK and
// never appear in these tables.
func countEstablished(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		// sl local_address rem_address st ...
		if len(fields) < 4 || fields[3] != "01" {
			continue
		}
		if isLoopback(fields[1]) {
			continue
		}
		n++
	}
	return n, sc.Err()
}

// isLoopback decodes the hex "ADDR:PORT" form of /proc/net/tcp. The kernel
// prints each 32-bit word of the address in host byte order (little-endian
// on x86), so every 4-byte group is reversed.
func isLoopback(addrPort string) bool {
	addr, _, ok := strings.Cut(addrPort, ":")
	if !ok {
		return false
	}
	b, err := hex.DecodeString(addr)
	if err != nil || len(b)%4 != 0 {
		return false
	}
	for i := 0; i < len(b); i += 4 {
		b[i], b[i+1], b[i+2], b[i+3] = b[i+3], b[i+2], b[i+1], b[i]
	}
	return net.IP(b).IsLoopback()
}

func load1() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	f, _ := strconv.ParseFloat(fields[0], 64)
	return f
}
