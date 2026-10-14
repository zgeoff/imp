package contract

import (
	"flag"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/zgeoff/imp/agent/internal/exec"
	"github.com/zgeoff/imp/agent/internal/proto"
	"github.com/zgeoff/imp/agent/internal/services"
	"github.com/zgeoff/imp/agent/internal/session"
	"github.com/zgeoff/imp/agent/internal/tartool"
)

var write = flag.Bool("write", false, "rewrite testdata/guest from the values in guest_test.go")

const (
	bootID     = "6f1c2a9e-3b7d-4e58-9a10-2c4b8d7e5f31"
	generation = "0123456789abcdef0123456789abcdef"
	previousGn = "fedcba9876543210fedcba9876543210"
)

// guestMessages is one value per message the agent sends impd, with every
// field of every message set in at least one of them, so impd's tests see
// each field the agent can send. The fixtures hold them as the agent's own
// writer marshals them.
func guestMessages() map[string]any {
	previous := &proto.Previous{ExecutionGeneration: previousGn, End: 2048, Exit: &proto.Exit{Code: 1}}
	output := func(resume *proto.Resume) *proto.Output {
		return &proto.Output{BootId: bootID, ExecutionGeneration: generation, BufferStart: 512, End: 9000,
			Offset: 4096, Prelude: 12, Previous: previous, Resume: resume, Log: new(true)}
	}
	def := &proto.ServiceDef{Name: new("web"), Argv: []string{"/usr/bin/web", "--port", "8080"},
		Env: []string{"MODE=prod"}, Cwd: new("/srv/web"), User: new("dev"), Restart: new("on-failure"),
		Source: new("api")}

	return map[string]any{
		"ping": &proto.Ping{Ok: true, Version: proto.Version, UptimeMs: new(5321.0),
			IdentityReset: new(proto.IdentityResetOK), Stage: new(proto.StageTemplate), BootId: new(bootID),
			Inner: &proto.InnerStatus{Up: false, Restarts: 3, LastError: new("start inner init: exit status 1")}},
		"ping-inner-up": &proto.Ping{Ok: true, Version: proto.Version, UptimeMs: new(5321.0), BootId: new(bootID),
			Inner: &proto.InnerStatus{Up: true}},
		"ok": &proto.OK{Ok: true},
		"error": &proto.ErrorResponse{Error: &proto.Error{Code: proto.ErrInnerDown,
			Message: "the inner container is down"}},
		"error-no-session": &proto.ErrorResponse{Error: &proto.Error{Code: proto.ErrNoSession,
			Message: "no session build", Data: &proto.ErrorData{BootId: new(bootID), Previous: previous}}},
		"error-invalid-resume": &proto.ErrorResponse{Error: &proto.Error{Code: proto.ErrInvalidResume,
			Message: "offset 9999 is past the end", Data: &proto.ErrorData{End: new(9000.0), BufferStart: new(512.0)}}},
		"listening-socket": &proto.Listening{Ok: true, Path: new("/run/imp/agent/ssh-1.sock"), Listener: "l1"},
		"listening-port":   &proto.Listening{Ok: true, Port: new(uint32(41234)), Listener: "l2"},
		"connection":       &proto.Connection{Id: 7},
		"activity": &proto.Activity{TcpEstablished: 2, ExecSessions: 1, Load1: 0.25,
			Sessions: []*proto.SessionInfo{{Name: "build", Pid: 812, Argv: []string{"make", "-j4"},
				State: proto.SessionExited, Attached: true, Cols: 120, Rows: 40,
				StartedUnixMs: 1760000000000, Exit: &proto.Exit{Code: 137, Signal: 9},
				ExecutionGeneration: generation, BootId: bootID, End: 9000, Log: new(true)}}},
		"started": &proto.Started{Pid: 812, Session: new("build"), Created: new(true), KillGraceMs: new(uint32(5000)),
			Output: output(&proto.Resume{Kind: proto.ResumeGenerationChanged, ExecutionGeneration: new(generation),
				FirstOffset: new(128.0)})},
		"started-resume-gap": &proto.Started{Pid: 812, Session: new("build"),
			Output: output(&proto.Resume{Kind: proto.ResumeGap, From: new(4096.0), To: new(8192.0)})},
		"started-resume-exact": &proto.Started{Pid: 812, Session: new("build"),
			Output: output(&proto.Resume{Kind: proto.ResumeExact})},
		"exit":     &proto.Exit{Code: 137, Signal: 9},
		"detached": &proto.Detached{Reason: proto.DetachTakenOver},
		"services-list": &proto.ServicesList{ImageUser: "dev", Services: []*proto.ServiceStatus{{
			Name: "web", State: "backoff", Pid: new(int32(901)), Restarts: 2, LastExit: &proto.Exit{Code: 1},
			Def: def, Root: new(true)}}},
		"cursor": &proto.LogCursor{Inode: 131074, Offset: 65536},
	}
}

// guestFixtures is every file in testdata/guest: the messages, and the
// numbers and names impd copies from the agent.
func guestFixtures(t *testing.T) map[string]any {
	t.Helper()
	fixtures := guestMessages()
	fixtures["frame-types"] = frameTypes(t)
	fixtures["error-codes"] = errorCodes(t)
	fixtures["limits"] = map[string]any{
		"max_payload":          proto.MaxPayload,
		"max_kill_grace_ms":    exec.MaxKillGrace / time.Millisecond,
		"max_log_lines":        services.MaxLogLines,
		"session_name_pattern": session.NamePattern.String(),
		"service_name_pattern": services.NameRule.String(),
	}
	fixtures["tar"] = map[string]any{"total_record": tartool.TotalRecord}
	return fixtures
}

func TestGuestFixturesMatchWhatTheAgentSends(t *testing.T) {
	dir := filepath.Join("testdata", "guest")
	fixtures := guestFixtures(t)
	if *write {
		assert.NilError(t, os.RemoveAll(dir))
		assert.NilError(t, os.MkdirAll(dir, 0o755))
	}

	for name, value := range fixtures {
		t.Run(name, func(t *testing.T) {
			want := encodeFixture(t, value)
			path := filepath.Join(dir, name+".json")
			if *write {
				assert.NilError(t, os.WriteFile(path, want, 0o644))
				return
			}

			got, err := os.ReadFile(path)
			assert.NilError(t, err, "run go test ./internal/contract -run GuestFixtures -write")

			// the values, not the bytes: the repo's formatter lays the files out
			assert.DeepEqual(t, decodeJSON(t, got), decodeJSON(t, want))
		})
	}
}

func TestGuestFixturesHoldNoFileTheAgentDoesNotWrite(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("testdata", "guest"))
	assert.NilError(t, err)
	var stale []string
	fixtures := guestFixtures(t)
	for _, entry := range entries {
		if _, ok := fixtures[strings.TrimSuffix(entry.Name(), ".json")]; !ok {
			stale = append(stale, entry.Name())
		}
	}

	assert.DeepEqual(t, stale, []string(nil))
}

func TestGuestMessagesSetEveryFieldOfEveryType(t *testing.T) {
	c := coverage{}
	for _, value := range guestMessages() {
		c.add(value)
	}

	assert.DeepEqual(t, c.unset(), []string(nil))
}

func TestEveryFrameTypeHasAName(t *testing.T) {
	var unnamed []string
	for name, number := range declaredConsts(t, "../proto/proto.go", "Type") {
		if strings.HasPrefix(proto.Type(number.(int)).String(), "Type(") {
			unnamed = append(unnamed, name)
		}
	}

	assert.DeepEqual(t, unnamed, []string(nil))
}

// frameTypes maps each frame type's name to its number.
func frameTypes(t *testing.T) map[string]int {
	t.Helper()
	types := map[string]int{}
	for _, number := range declaredConsts(t, "../proto/proto.go", "Type") {
		types[proto.Type(number.(int)).String()] = number.(int)
	}
	return types
}

// errorCodes is every Err constant of the proto package, sorted.
func errorCodes(t *testing.T) []string {
	t.Helper()
	var codes []string
	for _, code := range declaredConsts(t, "../proto/messages.go", "Err") {
		codes = append(codes, code.(string))
	}
	slices.Sort(codes)
	return codes
}
