package server

import (
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/imp/agent/internal/disk"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/safe"
)

// defaultFreezeTimeout auto-thaws / if the host never sends thaw, so a host
// crash mid-checkpoint cannot leave the guest wedged.
const defaultFreezeTimeout = 30 * time.Second

// _IOWR('X', 119, int) and _IOWR('X', 120, int); x/sys/unix lacks them.
const (
	fiFreeze = 0xC0045877
	fiThaw   = 0xC0045878
)

// rootIoctl is a variable so tests can run without root.
var rootIoctl = ioctlRoot

var (
	errFrozen      = &proto.Error{Code: proto.ErrFrozen, Message: "the root filesystem is already frozen"}
	errPoweringOff = &proto.Error{Code: proto.ErrPoweringOff, Message: "the guest is powering off"}
)

// freeze FIFREEZEs the root filesystem; the kernel syncs it first. A second
// freeze fails with FROZEN; it does not extend the first one's auto-thaw.
func (s *Server) freeze(timeout time.Duration) error {
	if timeout <= 0 {
		timeout = defaultFreezeTimeout
	}
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	if s.poweringOff {
		return errPoweringOff
	}
	if s.frozen {
		return errFrozen
	}
	// No unix.Sync first: freeze_super syncs the filesystem itself, and a
	// global sync would block on another frozen filesystem.
	if err := rootIoctl(fiFreeze); err != nil {
		// EBUSY: frozen by someone else, such as fsfreeze in the guest.
		if errors.Is(err, unix.EBUSY) {
			return errFrozen
		}
		return fmt.Errorf("FIFREEZE: %w", err)
	}
	s.frozen = true
	s.freezeGen++
	gen := s.freezeGen
	// Stop cannot cancel a callback that already fired and waits on
	// freezeMu, so the callback checks that its freeze is still current.
	s.thawTimer = time.AfterFunc(timeout, func() {
		defer safe.Recover("auto-thaw", nil)
		s.freezeMu.Lock()
		defer s.freezeMu.Unlock()
		if gen != s.freezeGen {
			return
		}
		log.Printf("freeze: no thaw after %s, thawing", timeout)
		if err := s.thawLocked(); err != nil {
			log.Printf("freeze: auto-thaw: %v", err)
		}
	})
	return nil
}

// growTimeout bounds the wait for the guest to see the disk's new size.
const growTimeout = 10 * time.Second

// waitAndGrow is a variable so tests can run without a disk.
var waitAndGrow = disk.WaitAndGrow

// grow resizes the root filesystem once the disk reaches diskBytes. A frozen
// filesystem would block the resize, so a grow during a freeze fails with
// FROZEN, and a freeze waits for a grow.
func (s *Server) grow(diskBytes int64) error {
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	if s.frozen {
		return errFrozen
	}
	return waitAndGrow("/", diskBytes, growTimeout)
}

// thaw FITHAWs the root filesystem. Thawing an unfrozen fs is not an error.
func (s *Server) thaw() error {
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	return s.thawLocked()
}

// ThawForPoweroff thaws the root filesystem and refuses later freezes, so
// poweroff can stop processes, sync and remount without blocking on it.
func (s *Server) ThawForPoweroff() error {
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	s.poweringOff = true
	return s.thawLocked()
}

func (s *Server) thawLocked() error {
	s.freezeGen++
	if s.thawTimer != nil {
		s.thawTimer.Stop()
		s.thawTimer = nil
	}
	if err := rootIoctl(fiThaw); err != nil && err != unix.EINVAL {
		return fmt.Errorf("FITHAW: %w", err)
	}
	s.frozen = false
	return nil
}

func ioctlRoot(req uint) error {
	f, err := os.Open("/")
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = unix.IoctlRetInt(int(f.Fd()), req)
	return err
}
