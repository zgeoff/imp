package services

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/proto"
)

// newManagedSupervisor is a supervisor with its own services.d.
func newManagedSupervisor(t *testing.T) *Supervisor {
	t.Helper()
	s := newSupervisor(t)
	s.dir = filepath.Join(t.TempDir(), "services.d")
	return s
}

// requireCode fails the test unless err is a proto.Error with code.
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var pe *proto.Error
	assert.Assert(t, errors.As(err, &pe), "err = %v, want %s", err, code)
	assert.Equal(t, pe.Code, code)
}

// waitRunning waits for the named service to run with a pid other than not.
func waitRunning(t *testing.T, s *Supervisor, name string, not int) proto.ServiceStatus {
	t.Helper()
	var got proto.ServiceStatus
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		list := s.List()
		for _, st := range list {
			if st.Name == name && st.State == "running" && st.Pid != not {
				got = st
				return poll.Success()
			}
		}
		return poll.Continue("%s is not running with a pid other than %d: %+v", name, not, list)
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))
	return got
}

func readDefFile(t *testing.T, path string) Def {
	t.Helper()
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	var d Def
	assert.NilError(t, json.Unmarshal(b, &d))
	return d
}

func TestAddWritesTheFileAndStartsTheService(t *testing.T) {
	s := newManagedSupervisor(t)

	err := s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}, Env: []string{"A=1"}}, false)

	assert.NilError(t, err)
	st := waitRunning(t, s, "web", 0)
	assert.Check(t, cmp.DeepEqual(st.Def, Def{Name: "web", Argv: []string{"sleep", "30"}, Env: []string{"A=1"}, Restart: "always", Source: "api"}))
	// the file holds no name: its own name is the service's
	assert.Check(t, cmp.DeepEqual(readDefFile(t, filepath.Join(s.dir, "web.json")), Def{Argv: []string{"sleep", "30"}, Env: []string{"A=1"}, Restart: "always", Source: "api"}))
	_, statErr := os.Stat(filepath.Join(s.dir, "web.json.tmp"))
	assert.Check(t, cmp.ErrorIs(statErr, fs.ErrNotExist), "the temp file is left")
}

func TestAddRefusesAServiceThatRuns(t *testing.T) {
	s := newManagedSupervisor(t)
	assert.NilError(t, s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}}, false))
	waitRunning(t, s, "web", 0)

	err := s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}}, false)

	requireCode(t, err, proto.ErrServiceTaken)
}

func TestAddWithReplaceRestartsTheServiceFromTheNewDefinition(t *testing.T) {
	s := newManagedSupervisor(t)
	assert.NilError(t, s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}}, false))
	first := waitRunning(t, s, "web", 0)

	err := s.Add(Def{Name: "web", Argv: []string{"sleep", "31"}}, true)

	assert.NilError(t, err)
	again := waitRunning(t, s, "web", first.Pid)
	assert.Check(t, cmp.DeepEqual(again.Def.Argv, []string{"sleep", "31"}))
	assert.Check(t, cmp.DeepEqual(readDefFile(t, filepath.Join(s.dir, "web.json")).Argv, []string{"sleep", "31"}))
}

func TestAddRefusesAFileWrittenByHand(t *testing.T) {
	s := newManagedSupervisor(t)
	assert.NilError(t, writeDef(fsroot.Host, filepath.Join(s.dir, "db.json"), Def{Argv: []string{"true"}}))

	err := s.Add(Def{Name: "db", Argv: []string{"true"}}, false)

	requireCode(t, err, proto.ErrServiceTaken)
}

func TestAddRefusesABadDefinitionAndWritesNothing(t *testing.T) {
	for _, tc := range []struct {
		name string
		def  Def
	}{
		{name: "an empty name", def: Def{Name: "", Argv: []string{"x"}}},
		{name: "a path", def: Def{Name: "../x", Argv: []string{"x"}}},
		{name: "an uppercase name", def: Def{Name: "Web", Argv: []string{"x"}}},
		{name: "an underscore", def: Def{Name: "a_b", Argv: []string{"x"}}},
		{name: "a dot", def: Def{Name: "a.b", Argv: []string{"x"}}},
		{name: "no argv", def: Def{Name: "web", Argv: nil}},
		{name: "an unknown restart policy", def: Def{Name: "web", Argv: []string{"x"}, Restart: "sometimes"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newManagedSupervisor(t)

			err := s.Add(tc.def, false)

			requireCode(t, err, proto.ErrBadRequest)
			_, statErr := os.Stat(s.dir)
			assert.Check(t, cmp.ErrorIs(statErr, fs.ErrNotExist), "a refused add wrote services.d")
		})
	}
}

// setupEscape points s at a services.d two levels down and writes the file
// that the name ../../tmp/x would reach from it.
func setupEscape(t *testing.T, s *Supervisor) (victim string) {
	t.Helper()
	base := t.TempDir()
	s.dir = filepath.Join(base, "a", "b", "services.d")
	victim = filepath.Join(base, "a", "tmp", "x.json")
	assert.NilError(t, os.MkdirAll(filepath.Dir(victim), 0o755))
	assert.NilError(t, os.WriteFile(victim, []byte(`{"argv":["sleep","30"]}`), 0o644))
	return victim
}

func TestRemoveRefusesANameOutsideServicesD(t *testing.T) {
	s := newManagedSupervisor(t)
	victim := setupEscape(t, s)

	err := s.Remove("../../tmp/x")

	requireCode(t, err, proto.ErrBadRequest)
	assert.Check(t, exists(fsroot.Host, victim), "remove deleted a file outside services.d")
}

func TestRestartRefusesANameOutsideServicesD(t *testing.T) {
	s := newManagedSupervisor(t)
	setupEscape(t, s)

	err := s.Restart("../../tmp/x")

	requireCode(t, err, proto.ErrBadRequest)
	assert.Check(t, cmp.Len(s.List(), 0), "restart started a service")
}

func TestRemoveStopsTheServiceAndDeletesItsFile(t *testing.T) {
	s := newManagedSupervisor(t)
	assert.NilError(t, s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}}, false))
	st := waitRunning(t, s, "web", 0)

	err := s.Remove("web")

	assert.NilError(t, err)
	assert.Check(t, cmp.Len(s.List(), 0))
	assert.Check(t, !exists(fsroot.Host, filepath.Join(s.dir, "web.json")), "the file is left")
	assert.Check(t, cmp.ErrorIs(syscallKill(st.Pid), syscall.ESRCH), "pid %d still runs", st.Pid)
}

func TestRemoveReportsNoServiceForOneAlreadyRemoved(t *testing.T) {
	s := newManagedSupervisor(t)
	assert.NilError(t, s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}}, false))
	waitRunning(t, s, "web", 0)
	assert.NilError(t, s.Remove("web"))

	err := s.Remove("web")

	requireCode(t, err, proto.ErrNoService)
}

func TestRestartRunsTheEditedFile(t *testing.T) {
	s := newManagedSupervisor(t)
	assert.NilError(t, s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}}, false))
	first := waitRunning(t, s, "web", 0)
	assert.NilError(t, writeDef(fsroot.Host, filepath.Join(s.dir, "web.json"), Def{Name: "web", Argv: []string{"sleep", "32"}}))

	err := s.Restart("web")

	assert.NilError(t, err)
	second := waitRunning(t, s, "web", first.Pid)
	assert.DeepEqual(t, second.Def.Argv, []string{"sleep", "32"})
}

func TestRestartStartsAFileWrittenAfterBoot(t *testing.T) {
	s := newManagedSupervisor(t)
	assert.NilError(t, writeDef(fsroot.Host, filepath.Join(s.dir, "late.json"), Def{Argv: []string{"sleep", "30"}}))

	err := s.Restart("late")

	assert.NilError(t, err)
	waitRunning(t, s, "late", 0)
}

func TestRestartReportsNoServiceForAnUnknownName(t *testing.T) {
	s := newManagedSupervisor(t)

	err := s.Restart("nope")

	requireCode(t, err, proto.ErrNoService)
}

func TestRestartRefusesAFileThatDoesNotParse(t *testing.T) {
	s := newManagedSupervisor(t)
	assert.NilError(t, os.MkdirAll(s.dir, 0o755))
	assert.NilError(t, os.WriteFile(filepath.Join(s.dir, "web.json"), []byte(`{`), 0o644))

	err := s.Restart("web")

	requireCode(t, err, proto.ErrBadRequest)
	assert.Check(t, cmp.Len(s.List(), 0), "restart started a service")
}

func TestRestartKeepsAServiceWhoseFileIsGone(t *testing.T) {
	s := newManagedSupervisor(t)
	s.Start(Def{Name: "mem", Argv: []string{"sleep", "30"}, Restart: "always"})
	first := waitRunning(t, s, "mem", 0)

	err := s.Restart("mem")

	assert.NilError(t, err)
	again := waitRunning(t, s, "mem", first.Pid)
	assert.DeepEqual(t, again.Def, Def{Name: "mem", Argv: []string{"sleep", "30"}, Restart: "always"})
}

func TestAddAfterStopAllIsRefusedAsPoweringOff(t *testing.T) {
	s := newManagedSupervisor(t)
	s.StopAll()

	err := s.Add(Def{Name: "web", Argv: []string{"true"}}, false)

	requireCode(t, err, proto.ErrPoweringOff)
}

func TestRestartAfterStopAllIsRefusedAsPoweringOff(t *testing.T) {
	s := newManagedSupervisor(t)
	s.StopAll()

	err := s.Restart("web")

	requireCode(t, err, proto.ErrPoweringOff)
}

func TestListSaysWhichServicesRunAsRoot(t *testing.T) {
	s := newManagedSupervisor(t)
	s.Start(Def{Name: "rooted", Argv: []string{"sleep", "30"}, Restart: "always"})
	s.Start(Def{Name: "nobody", Argv: []string{"sleep", "30"}, User: "65534", Restart: "always"})

	root := map[string]bool{}
	for _, st := range s.List() {
		root[st.Name] = st.Root
	}

	assert.DeepEqual(t, root, map[string]bool{"rooted": true, "nobody": false})
}
