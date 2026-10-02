// isn-probe prints the secret part of the guest's TCP initial sequence
// number: the ISN of one loopback connection on a fixed 4-tuple, less the
// clock term the kernel adds (secure_tcp_seq: hash + realtime_ns >> 6). Two
// guests that share the kernel's net_secret print values a few hundred apart;
// two that do not, values with nothing in common. Needs root, for TCP_REPAIR.
package main

import (
	"fmt"
	"net"
	"os"
	"syscall"
	"time"
)

const (
	tcpRepair      = 19
	tcpRepairQueue = 20
	tcpQueueSeq    = 21
	tcpSendQueue   = 2
)

func main() {
	l, err := net.Listen("tcp4", "127.0.0.1:9100")
	if err != nil {
		fail(err)
	}
	defer l.Close()

	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		fail(err)
	}
	defer syscall.Close(fd)
	// close with a reset, so a second run can bind the same port at once
	if err := syscall.SetsockoptLinger(fd, syscall.SOL_SOCKET, syscall.SO_LINGER, &syscall.Linger{Onoff: 1, Linger: 0}); err != nil {
		fail(err)
	}
	if err := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
		fail(err)
	}
	loopback := [4]byte{127, 0, 0, 1}
	if err := syscall.Bind(fd, &syscall.SockaddrInet4{Port: 9101, Addr: loopback}); err != nil {
		fail(err)
	}

	clock := time.Now().UnixNano()
	if err := syscall.Connect(fd, &syscall.SockaddrInet4{Port: 9100, Addr: loopback}); err != nil {
		fail(err)
	}

	if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_TCP, tcpRepair, 1); err != nil {
		fail(err)
	}
	if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_TCP, tcpRepairQueue, tcpSendQueue); err != nil {
		fail(err)
	}
	// the next byte to send: the ISN plus the SYN
	seq, err := syscall.GetsockoptInt(fd, syscall.IPPROTO_TCP, tcpQueueSeq)
	if err != nil {
		fail(err)
	}
	isn := uint32(seq) - 1
	fmt.Println(isn - uint32(clock>>6))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "isn-probe:", err)
	os.Exit(1)
}
