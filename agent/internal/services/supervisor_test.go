package services

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/reaper"
)

// The reaper runs a process-wide wait4 loop, so the package shares one.
var testReaper *reaper.Reaper

func TestMain(m *testing.M) {
	testReaper = reaper.New()
	log.SetOutput(io.Discard)
	os.Exit(m.Run())
}

// newSupervisor runs services as direct children, with their logs in a
// temporary directory. StopAll ends whatever the test started.
func newSupervisor(t *testing.T) *Supervisor {
	t.Helper()
	s := New(&proc.Direct{Reaper: testReaper}, fsroot.Host, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}))
	s.logDir = t.TempDir()
	t.Cleanup(s.StopAll)
	return s
}

// TestStopAllDeliversSIGTERMWhenItLandsDuringAStart stops a service at
// offsets 50µs apart across its start: each offset is a fault-injection
// point, not a settling delay. A SIGTERM lost to the window between fork
// and recording the process would make StopAll wait out stopGrace and
// SIGKILL.
func TestStopAllDeliversSIGTERMWhenItLandsDuringAStart(t *testing.T) {
	for i := range 100 {
		offset := time.Duration(i) * 50 * time.Microsecond
		t.Run(fmt.Sprintf("stop %s into the start", offset), func(t *testing.T) {
			s := newSupervisor(t)
			s.Start(Def{Name: "sleeper", Argv: []string{"sleep", "30"}, Restart: "always"})
			time.Sleep(offset)

			began := time.Now()
			s.StopAll()
			took := time.Since(began)

			assert.Check(t, took < stopGrace, "StopAll took %s; SIGTERM was lost", took)
			list := s.List()
			assert.Assert(t, cmp.Len(list, 1))
			assert.Check(t, cmp.Equal(list[0].State, "stopped"))
		})
	}
}

// TestAFailedRestartKeepsTheLastExit runs a service that exits 3 and
// deletes itself, so every restart fails to start.
func TestAFailedRestartKeepsTheLastExit(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "once")
	assert.NilError(t, os.WriteFile(bin, []byte("#!/bin/sh\nrm -f \"$0\"\nexit 3\n"), 0o755))
	s := newSupervisor(t)

	s.Start(Def{Name: "once", Argv: []string{bin}, Restart: "always"})

	// The first restart comes after minBackoff and fails.
	var st proto.ServiceStatus
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		st = s.List()[0]
		if st.Restarts >= 2 {
			return poll.Success()
		}
		return poll.Continue("the service restarted %d times, want 2", st.Restarts)
	}, poll.WithTimeout(minBackoff+3*time.Second), poll.WithDelay(20*time.Millisecond))
	assert.DeepEqual(t, st.LastExit, &proto.Exit{Code: 3})
}

// openLogWithin runs openLog for svc and returns its error, failing the
// test if the open blocks. A file it did open is closed.
func openLogWithin(t *testing.T, s *Supervisor, svc *service) error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		f, err := s.openLog(svc)
		if err == nil {
			f.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("openLog blocked on a FIFO")
		return nil
	}
}

// TestOpenLogRefusesAFIFOWithoutAReaderWithoutBlocking puts a FIFO at a
// service's log with no reader: a blocking open would hold the service's
// loop.
func TestOpenLogRefusesAFIFOWithoutAReaderWithoutBlocking(t *testing.T) {
	s := newSupervisor(t)
	svc := &service{def: Def{Name: "fifo"}}
	assert.NilError(t, unix.Mkfifo(s.logPath(svc), 0o644))

	err := openLogWithin(t, s, svc)

	// a non-blocking write open of a FIFO with no reader
	assert.ErrorIs(t, err, unix.ENXIO)
}

// TestOpenLogRefusesAFIFOWithAReaderAsNotRegular puts a FIFO with a reader
// at a service's log: the open works, and the regular-file check must
// refuse it.
func TestOpenLogRefusesAFIFOWithAReaderAsNotRegular(t *testing.T) {
	s := newSupervisor(t)
	svc := &service{def: Def{Name: "fifo"}}
	assert.NilError(t, unix.Mkfifo(s.logPath(svc), 0o644))
	r, err := os.OpenFile(s.logPath(svc), os.O_RDONLY|unix.O_NONBLOCK, 0)
	assert.NilError(t, err)
	t.Cleanup(func() { r.Close() })

	err = openLogWithin(t, s, svc)

	assert.ErrorIs(t, err, fsroot.ErrNotRegular)
}

// TestOpenLogHandsTheServiceABlockingFile: the service gets its log without
// O_NONBLOCK, as it would get any file.
func TestOpenLogHandsTheServiceABlockingFile(t *testing.T) {
	s := newSupervisor(t)

	f, err := s.openLog(&service{def: Def{Name: "plain"}})

	assert.NilError(t, err)
	t.Cleanup(func() { f.Close() })
	// not f.Fd(), which clears the flag itself
	conn, err := f.SyscallConn()
	assert.NilError(t, err)
	var flags int
	var flagsErr error
	assert.NilError(t, conn.Control(func(fd uintptr) { flags, flagsErr = unix.FcntlInt(fd, unix.F_GETFL, 0) }))
	assert.NilError(t, flagsErr)
	assert.Check(t, flags&unix.O_NONBLOCK == 0, "the log is open with O_NONBLOCK")
}
