package services

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/zgeoff/imp/agent/internal/proto"
)

func newManagedSupervisor(t *testing.T) *Supervisor {
	t.Helper()
	s := newSupervisor(t)
	s.dir = filepath.Join(t.TempDir(), "services.d")
	t.Cleanup(s.StopAll)
	return s
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != code {
		t.Fatalf("err = %v, want %s", err, code)
	}
}

// waitRunning waits for the named service to run with a pid other than not.
func waitRunning(t *testing.T, s *Supervisor, name string, not int) proto.ServiceStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, st := range s.List() {
			if st.Name == name && st.State == "running" && st.Pid != not {
				return st
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s did not run: %+v", name, s.List())
	return proto.ServiceStatus{}
}

func readFile(t *testing.T, path string) Def {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d Def
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestAddWritesTheFileAndStarts(t *testing.T) {
	s := newManagedSupervisor(t)
	def := Def{Name: "web", Argv: []string{"sleep", "30"}, Env: []string{"A=1"}}
	if err := s.Add(def, false); err != nil {
		t.Fatal(err)
	}
	st := waitRunning(t, s, "web", 0)
	want := Def{Name: "web", Argv: []string{"sleep", "30"}, Env: []string{"A=1"}, Restart: "always", Source: "api"}
	if !reflect.DeepEqual(st.Def, want) {
		t.Fatalf("def = %+v, want %+v", st.Def, want)
	}
	// the file holds no name: its own name is the service's
	inFile := want
	inFile.Name = ""
	if got := readFile(t, filepath.Join(s.dir, "web.json")); !reflect.DeepEqual(got, inFile) {
		t.Fatalf("file = %+v, want %+v", got, inFile)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "web.json.tmp")); !os.IsNotExist(err) {
		t.Fatalf("the temp file is left: %v", err)
	}

	requireCode(t, s.Add(def, false), proto.ErrServiceTaken)

	if err := s.Add(Def{Name: "web", Argv: []string{"sleep", "31"}}, true); err != nil {
		t.Fatal(err)
	}
	again := waitRunning(t, s, "web", st.Pid)
	if again.Def.Argv[1] != "31" || readFile(t, filepath.Join(s.dir, "web.json")).Argv[1] != "31" {
		t.Fatalf("the replace did not apply: %+v", again)
	}
}

func TestAddRefusesAFileWrittenByHand(t *testing.T) {
	s := newManagedSupervisor(t)
	if err := writeDef(filepath.Join(s.dir, "db.json"), Def{Argv: []string{"true"}}); err != nil {
		t.Fatal(err)
	}
	requireCode(t, s.Add(Def{Name: "db", Argv: []string{"true"}}, false), proto.ErrServiceTaken)
}

func TestAddChecksTheDefinition(t *testing.T) {
	s := newManagedSupervisor(t)
	for _, def := range []Def{
		{Name: "", Argv: []string{"x"}},
		{Name: "../x", Argv: []string{"x"}},
		{Name: "Web", Argv: []string{"x"}},
		{Name: "a_b", Argv: []string{"x"}},
		{Name: "a.b", Argv: []string{"x"}},
		{Name: "web", Argv: nil},
		{Name: "web", Argv: []string{"x"}, Restart: "sometimes"},
	} {
		requireCode(t, s.Add(def, false), proto.ErrBadRequest)
	}
	if entries, _ := os.ReadDir(s.dir); len(entries) != 0 {
		t.Fatalf("a refused add wrote %v", entries)
	}
}

func TestRemoveAndRestartCheckTheName(t *testing.T) {
	s := newManagedSupervisor(t)
	base := t.TempDir()
	s.dir = filepath.Join(base, "a", "b", "services.d")
	// the file a path outside services.d would reach
	victim := filepath.Join(base, "a", "tmp", "x.json")
	if err := os.MkdirAll(filepath.Dir(victim), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(victim, []byte(`{"argv":["sleep","30"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	requireCode(t, s.Remove("../../tmp/x"), proto.ErrBadRequest)
	requireCode(t, s.Restart("../../tmp/x"), proto.ErrBadRequest)
	if !exists(victim) {
		t.Fatal("remove deleted a file outside services.d")
	}
	if len(s.List()) != 0 {
		t.Fatalf("restart started %+v", s.List())
	}
}

func TestRemoveStopsAndDeletes(t *testing.T) {
	s := newManagedSupervisor(t)
	if err := s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}}, false); err != nil {
		t.Fatal(err)
	}
	st := waitRunning(t, s, "web", 0)
	if err := s.Remove("web"); err != nil {
		t.Fatal(err)
	}
	if len(s.List()) != 0 {
		t.Fatalf("list = %+v after remove", s.List())
	}
	if exists(filepath.Join(s.dir, "web.json")) {
		t.Fatal("the file is left")
	}
	if err := syscallKill(st.Pid); err == nil {
		t.Fatalf("pid %d still runs", st.Pid)
	}
	requireCode(t, s.Remove("web"), proto.ErrNoService)
}

func TestRestartReadsTheFile(t *testing.T) {
	s := newManagedSupervisor(t)
	if err := s.Add(Def{Name: "web", Argv: []string{"sleep", "30"}}, false); err != nil {
		t.Fatal(err)
	}
	first := waitRunning(t, s, "web", 0)

	path := filepath.Join(s.dir, "web.json")
	if err := writeDef(path, Def{Name: "web", Argv: []string{"sleep", "32"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Restart("web"); err != nil {
		t.Fatal(err)
	}
	second := waitRunning(t, s, "web", first.Pid)
	if second.Def.Argv[1] != "32" {
		t.Fatalf("restart ran %v, want the edited file", second.Def.Argv)
	}

	// a file written after boot starts on its first restart
	if err := writeDef(filepath.Join(s.dir, "late.json"), Def{Argv: []string{"sleep", "30"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Restart("late"); err != nil {
		t.Fatal(err)
	}
	waitRunning(t, s, "late", 0)

	requireCode(t, s.Restart("nope"), proto.ErrNoService)
}

func TestRestartKeepsAServiceWhoseFileIsGone(t *testing.T) {
	s := newManagedSupervisor(t)
	s.Start(Def{Name: "mem", Argv: []string{"sleep", "30"}, Restart: "always"})
	first := waitRunning(t, s, "mem", 0)
	if err := s.Restart("mem"); err != nil {
		t.Fatal(err)
	}
	waitRunning(t, s, "mem", first.Pid)
}

func TestManagingAfterStopAllIsRefused(t *testing.T) {
	s := newManagedSupervisor(t)
	s.StopAll()
	requireCode(t, s.Add(Def{Name: "web", Argv: []string{"true"}}, false), proto.ErrPoweringOff)
	requireCode(t, s.Restart("web"), proto.ErrPoweringOff)
}

func TestListSaysWhichServicesRunAsRoot(t *testing.T) {
	s := newManagedSupervisor(t)
	s.Start(Def{Name: "rooted", Argv: []string{"sleep", "30"}, Restart: "always"})
	s.Start(Def{Name: "nobody", Argv: []string{"sleep", "30"}, User: "65534", Restart: "always"})
	got := map[string]bool{}
	for _, st := range s.List() {
		got[st.Name] = st.Root
	}
	if !got["rooted"] || got["nobody"] {
		t.Fatalf("root = %v, want rooted only", got)
	}
}
