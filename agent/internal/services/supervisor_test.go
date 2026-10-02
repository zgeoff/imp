package services

import (
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/imagecfg"
	"github.com/zgeoff/imp/agent/internal/proc"
	"github.com/zgeoff/imp/agent/internal/reaper"
	"golang.org/x/sys/unix"
)

// The reaper runs a process-wide wait4 loop, so the package shares one.
var testReaper *reaper.Reaper

func TestMain(m *testing.M) {
	testReaper = reaper.New()
	log.SetOutput(io.Discard)
	os.Exit(m.Run())
}

func newSupervisor(t *testing.T) *Supervisor {
	s := New(&proc.Direct{Reaper: testReaper}, fsroot.Host, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}))
	s.logDir = t.TempDir()
	return s
}

// TestStopAllDuringStart stops a service at varying points of its start.
// A SIGTERM lost to the window between fork and recording the process
// would make StopAll wait out stopGrace and SIGKILL.
func TestStopAllDuringStart(t *testing.T) {
	for i := range 100 {
		s := newSupervisor(t)
		s.Start(Def{Name: "sleeper", Argv: []string{"sleep", "30"}, Restart: "always"})
		time.Sleep(time.Duration(i) * 50 * time.Microsecond)
		began := time.Now()
		s.StopAll()
		if took := time.Since(began); took >= stopGrace {
			t.Fatalf("run %d: StopAll took %s; SIGTERM was lost", i, took)
		}
		if st := s.List()[0]; st.State != "stopped" {
			t.Fatalf("run %d: state %q, want stopped", i, st.State)
		}
	}
}

// TestFailedStartKeepsLastExit runs a service that exits 3 and deletes
// itself, so every restart fails to start.
func TestFailedStartKeepsLastExit(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "once")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nrm -f \"$0\"\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := newSupervisor(t)
	defer s.StopAll()
	s.Start(Def{Name: "once", Argv: []string{bin}, Restart: "always"})

	// The first restart comes after minBackoff and fails.
	deadline := time.Now().Add(minBackoff + 3*time.Second)
	for time.Now().Before(deadline) {
		st := s.List()[0]
		if st.Restarts >= 2 {
			if st.LastExit == nil || st.LastExit.Code != 3 {
				t.Fatalf("last_exit = %+v after a failed start, want code 3", st.LastExit)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the service did not restart twice")
}

// TestLogOpenRefusesAFIFO puts a FIFO at a service's log. With no reader,
// a blocking open would hold the service's loop; with one, the open works
// and the regular-file check must refuse it.
func TestLogOpenRefusesAFIFO(t *testing.T) {
	for _, withReader := range []bool{false, true} {
		s := newSupervisor(t)
		svc := &service{def: Def{Name: "fifo"}}
		if err := unix.Mkfifo(s.logPath(svc), 0o644); err != nil {
			t.Fatal(err)
		}
		if withReader {
			r, err := os.OpenFile(s.logPath(svc), os.O_RDONLY|unix.O_NONBLOCK, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
		}
		err := checkLogOpenFails(t, s, svc)
		if withReader && !errors.Is(err, fsroot.ErrNotRegular) {
			t.Fatalf("with a reader: %v, want %v", err, fsroot.ErrNotRegular)
		}
	}
}

func checkLogOpenFails(t *testing.T, s *Supervisor, svc *service) error {
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
		if err == nil {
			t.Fatal("openLog opened a FIFO")
		}
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("openLog blocked on a FIFO")
		return nil
	}
}

// TestLogIsBlockingForTheService: the service gets its log without
// O_NONBLOCK, as it would get any file.
func TestLogIsBlockingForTheService(t *testing.T) {
	s := newSupervisor(t)
	f, err := s.openLog(&service{def: Def{Name: "plain"}})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	// not f.Fd(), which clears the flag itself
	conn, err := f.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var flags int
	if err := conn.Control(func(fd uintptr) { flags, err = unix.FcntlInt(fd, unix.F_GETFL, 0) }); err != nil {
		t.Fatal(err)
	}
	if err != nil {
		t.Fatal(err)
	}
	if flags&unix.O_NONBLOCK != 0 {
		t.Fatal("the log is open with O_NONBLOCK")
	}
}
