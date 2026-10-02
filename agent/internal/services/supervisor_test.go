package services

import (
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
)

// The reaper runs a process-wide wait4 loop, so the package shares one.
var testReaper *reaper.Reaper

func TestMain(m *testing.M) {
	testReaper = reaper.New()
	log.SetOutput(io.Discard)
	os.Exit(m.Run())
}

func newSupervisor(t *testing.T) *Supervisor {
	s := New(&proc.Direct{Reaper: testReaper}, fsroot.Host, imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}})
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
