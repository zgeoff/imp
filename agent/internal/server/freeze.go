package server

import (
	"fmt"
	"log"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// defaultFreezeTimeout auto-thaws / if the host never sends thaw, so a host
// crash mid-checkpoint cannot leave the guest wedged.
const defaultFreezeTimeout = 30 * time.Second

// _IOWR('X', 119, int) and _IOWR('X', 120, int); x/sys/unix lacks them.
const (
	fiFreeze = 0xC0045877
	fiThaw   = 0xC0045878
)

// freeze syncs and FIFREEZEs the root filesystem.
func (s *Server) freeze(timeout time.Duration) error {
	if timeout <= 0 {
		timeout = defaultFreezeTimeout
	}
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	unix.Sync()
	if err := rootIoctl(fiFreeze); err != nil {
		return fmt.Errorf("FIFREEZE: %w", err)
	}
	if s.thawTimer != nil {
		s.thawTimer.Stop()
	}
	s.thawTimer = time.AfterFunc(timeout, func() {
		log.Printf("freeze: no thaw after %s, thawing", timeout)
		s.thaw()
	})
	return nil
}

// thaw FITHAWs the root filesystem. Thawing an unfrozen fs is not an error.
func (s *Server) thaw() error {
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	if s.thawTimer != nil {
		s.thawTimer.Stop()
		s.thawTimer = nil
	}
	if err := rootIoctl(fiThaw); err != nil && err != unix.EINVAL {
		return fmt.Errorf("FITHAW: %w", err)
	}
	return nil
}

func rootIoctl(req uint) error {
	f, err := os.Open("/")
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = unix.IoctlRetInt(int(f.Fd()), req)
	return err
}
