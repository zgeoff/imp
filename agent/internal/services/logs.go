package services

import (
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"time"

	"github.com/zgeoff/imp/agent/internal/safe"
)

const (
	// maxLogSize caps a service log; past it the log moves to <name>.log.1,
	// replacing the previous one. Checks run every rotateEvery, so a log
	// can pass the cap by that much output.
	maxLogSize  = 10 << 20
	rotateEvery = time.Minute
)

// rotateLog renames a log over maxLogSize to <path>.1. It runs before a
// service start opens the log, when nothing writes to it.
func rotateLog(path string) error {
	if !oversize(path) {
		return nil
	}
	return os.Rename(path, path+".1")
}

// copyTruncateLog copies a log over maxLogSize to <path>.1 and empties it in
// place. The running service keeps its fd; it opened the log O_APPEND, so
// its next write lands at the new end. Lines written between the copy and
// the truncate are lost, which is the usual copytruncate trade.
func (s *Supervisor) copyTruncateLog(path string) error {
	if !oversize(path) {
		return nil
	}
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp := path + ".1.tmp"
	dst, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(tmp)
		return err
	}
	if err := dst.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path+".1"); err != nil {
		return err
	}
	s.truncMu.Lock()
	defer s.truncMu.Unlock()
	if err := os.Truncate(path, 0); err != nil {
		return err
	}
	s.truncs[path]++
	return nil
}

// readLogState returns how many times the rotator emptied the log at path,
// and its size, both read at one point between rotations.
func (s *Supervisor) readLogState(path string) (uint64, os.FileInfo, error) {
	s.truncMu.Lock()
	defer s.truncMu.Unlock()
	fi, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return s.truncs[path], nil, nil
	}
	return s.truncs[path], fi, err
}

func oversize(path string) bool {
	fi, err := os.Stat(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("services: %v", err)
		}
		return false
	}
	return fi.Size() > maxLogSize
}

// rotateLogs checks every service's log each rotateEvery until quit closes.
// It holds only the service's logMu during a copy, never s.mu, so List and
// StopAll never wait on disk I/O.
func (s *Supervisor) rotateLogs(quit <-chan struct{}) {
	t := time.NewTicker(rotateEvery)
	defer t.Stop()
	for {
		select {
		case <-quit:
			return
		case <-t.C:
		}
		// One bad tick must not end rotation for good.
		safe.Call("services: log rotator", s.rotateAll)
	}
}

func (s *Supervisor) rotateAll() {
	s.mu.Lock()
	svcs := make([]*service, 0, len(s.services))
	for _, svc := range s.services {
		svcs = append(svcs, svc)
	}
	s.mu.Unlock()
	for _, svc := range svcs {
		func() {
			svc.logMu.Lock()
			defer svc.logMu.Unlock()
			if err := s.copyTruncateLog(s.logPath(svc)); err != nil {
				log.Printf("services: %s: rotate log: %v", svc.def.Name, err)
			}
		}()
	}
}
