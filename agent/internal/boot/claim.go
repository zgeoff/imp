package boot

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"time"
	"unsafe"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/cmdline"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/server"
)

// claimRequestTimeout bounds how long a connection may take to send its
// request while stage 1 is parked.
const claimRequestTimeout = 10 * time.Second

// errNotParked answers any op but ping and claim while stage 1 is parked.
var errNotParked = &proto.Error{
	Code:    proto.ErrUnknownOp,
	Message: "the guest is a boot template waiting for claim",
}

// parkForClaim serves ping and claim on the agent's vsock port until a
// claim is applied, then closes the listener, so stage 2 can take the port.
// It opens no inet socket: the template's snapshot holds no TCP state.
// docs/architecture/boot-templates.md#claim has the order of the steps.
func parkForClaim(listen func() (net.Listener, error), apply func(proto.Claim) error) (proto.Claim, error) {
	l, err := listen()
	if err != nil {
		return proto.Claim{}, err
	}
	defer func() { l.Close() }()
	log.Printf("stage1: parked as a boot template")
	for {
		c, err := l.Accept()
		if err != nil {
			// a snapshot restore resets the vsock transport: listen again
			l.Close()
			time.Sleep(10 * time.Millisecond)
			if l, err = listen(); err != nil {
				return proto.Claim{}, err
			}
			continue
		}
		claim, done := serveParked(c, apply)
		if done {
			return claim, nil
		}
	}
}

// serveParked answers one connection; done is true once a claim applied.
func serveParked(c net.Conn, apply func(proto.Claim) error) (proto.Claim, bool) {
	defer c.Close()
	r, w := proto.NewReader(c), proto.NewWriter(c)
	c.SetReadDeadline(time.Now().Add(claimRequestTimeout))
	f, err := r.Next()
	if err != nil || f.Type != proto.TypeRequest {
		return proto.Claim{}, false
	}
	var req proto.Request
	if err := json.Unmarshal(f.Payload, &req); err != nil {
		w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: &proto.Error{Code: proto.ErrBadRequest, Message: err.Error()}})
		return proto.Claim{}, false
	}
	switch req.Op {
	case proto.OpPing:
		ping := server.BuildPing(unix.ClockGettime)
		ping.Stage = proto.StageTemplate
		w.WriteJSON(proto.TypeResponse, ping)
		return proto.Claim{}, false
	case proto.OpClaim:
		if req.Claim == nil || req.Claim.Hostname == "" || req.Claim.IP == "" {
			w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: &proto.Error{Code: proto.ErrBadRequest, Message: "claim needs a hostname and an ip"}})
			return proto.Claim{}, false
		}
		if err := apply(*req.Claim); err != nil {
			log.Printf("stage1: claim: %v", err)
			w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: &proto.Error{Code: proto.ErrInternal, Message: err.Error()}})
			return proto.Claim{}, false
		}
		w.WriteJSON(proto.TypeResponse, proto.OK{OK: true})
		return *req.Claim, true
	default:
		w.WriteJSON(proto.TypeResponse, proto.ErrorResponse{Error: errNotParked})
		return proto.Claim{}, false
	}
}

// claimParams is what stage 2 gets after a claim: the claim's values, never
// the template's cmdline.
func claimParams(c proto.Claim) cmdline.Params {
	return cmdline.Params{
		Hostname:      c.Hostname,
		IP:            c.IP,
		GW:            c.GW,
		IP6:           c.IP6,
		GW6:           c.GW6,
		DNS:           c.DNS,
		ResetIdentity: c.ResetIdentity,
		Raw:           map[string]string{"id": c.ID},
	}
}

// applyClaim makes the restored guest this imp's, in this order: the clock
// (so nothing below stamps the template's time), the entropy pool and a
// CRNG reseed, eth0's MAC, and the user disk's cached state, which the
// template never read but whose size changed under it.
func applyClaim(c proto.Claim) error {
	var errs []error
	if c.UnixMs > 0 {
		ts := unix.NsecToTimespec(c.UnixMs * int64(time.Millisecond))
		if err := unix.ClockSettime(unix.CLOCK_REALTIME, &ts); err != nil {
			errs = append(errs, fmt.Errorf("clock: %w", err))
		}
	}
	if err := addEntropy(c.Seed); err != nil {
		errs = append(errs, fmt.Errorf("entropy: %w", err))
	} else {
		log.Printf("stage1: claim: crng reseeded from a %d-byte seed", len(c.Seed))
	}
	if err := setMAC("eth0", c.MAC); err != nil {
		errs = append(errs, fmt.Errorf("mac: %w", err))
	}
	// a disk still at the placeholder's size would fail the mount in stage 2;
	// an error now lets the host boot the kernel at once
	readSize := func() (uint64, error) { return readDiskBytes(userDisk) }
	if err := waitForDiskSize(readSize, c.DiskBytes, diskSizeTimeout); err != nil {
		errs = append(errs, fmt.Errorf("%s: %w", userDisk, err))
	}
	if err := flushDisk(userDisk); err != nil {
		errs = append(errs, fmt.Errorf("%s: %w", userDisk, err))
	}
	return errors.Join(errs...)
}

// addEntropy credits seed to the pool (RNDADDENTROPY), then has the CRNG
// draw from it at once (RNDRESEEDCRNG) rather than at its next interval.
func addEntropy(seed []byte) error {
	if len(seed) < 32 {
		return fmt.Errorf("a seed of %d bytes; want at least 32", len(seed))
	}
	f, err := os.OpenFile("/dev/urandom", os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	// struct rand_pool_info { int entropy_count; int buf_size; __u32 buf[]; }
	info := make([]byte, 8+len(seed))
	*(*int32)(unsafe.Pointer(&info[0])) = int32(len(seed) * 8)
	*(*int32)(unsafe.Pointer(&info[4])) = int32(len(seed))
	copy(info[8:], seed)
	if err := ioctlPtr(f.Fd(), unix.RNDADDENTROPY, unsafe.Pointer(&info[0])); err != nil {
		return fmt.Errorf("RNDADDENTROPY: %w", err)
	}
	if err := ioctlPtr(f.Fd(), unix.RNDRESEEDCRNG, nil); err != nil {
		return fmt.Errorf("RNDRESEEDCRNG: %w", err)
	}
	return nil
}

func setMAC(iface, mac string) error {
	hw, err := net.ParseMAC(mac)
	if err != nil {
		return err
	}
	link, err := netlink.LinkByName(iface)
	if err != nil {
		return err
	}
	return netlink.LinkSetHardwareAddr(link, hw)
}

// diskSizeTimeout bounds the wait for virtio-blk to report the size the
// restore's PATCH gave the disk.
const diskSizeTimeout = 2 * time.Second

// sectorBytes is the unit virtio-blk reports a disk's size in.
const sectorBytes = 512

// waitForDiskSize waits until read reports at least want bytes, rounded
// down to whole sectors; want 0 skips.
func waitForDiskSize(read func() (uint64, error), want int64, timeout time.Duration) error {
	want -= want % sectorBytes
	if want <= 0 {
		return nil
	}
	deadline := time.Now().Add(timeout)
	for {
		got, err := read()
		if err == nil && int64(got) >= want {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("reports %d bytes after %s; want %d (%v)", got, timeout, want, err)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func readDiskBytes(dev string) (uint64, error) {
	f, err := os.OpenFile(dev, os.O_RDONLY, 0)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	var size uint64
	if err := ioctlPtr(f.Fd(), unix.BLKGETSIZE64, unsafe.Pointer(&size)); err != nil {
		return 0, fmt.Errorf("BLKGETSIZE64: %w", err)
	}
	return size, nil
}

// flushDisk drops the block device's buffers and rereads its partition
// table; a disk without one answers EINVAL, which is fine.
func flushDisk(dev string) error {
	f, err := os.OpenFile(dev, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := ioctlPtr(f.Fd(), unix.BLKFLSBUF, nil); err != nil {
		return fmt.Errorf("BLKFLSBUF: %w", err)
	}
	if err := ioctlPtr(f.Fd(), unix.BLKRRPART, nil); err != nil && !errors.Is(err, unix.EINVAL) {
		return fmt.Errorf("BLKRRPART: %w", err)
	}
	return nil
}

func ioctlPtr(fd uintptr, req uint, arg unsafe.Pointer) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, fd, uintptr(req), uintptr(arg))
	if errno != 0 {
		return errno
	}
	return nil
}
