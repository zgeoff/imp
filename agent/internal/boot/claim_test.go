package boot

import (
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zgeoff/imp/agent/internal/cmdline"
	"github.com/zgeoff/imp/agent/internal/proto"
)

// sendParked sends one request to the parked listener at sock and returns
// the reply's raw JSON.
func sendParked(t *testing.T, sock string, req proto.Request) string {
	t.Helper()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	w, r := proto.NewWriter(c), proto.NewReader(c)
	if err := w.WriteJSON(proto.TypeRequest, req); err != nil {
		t.Fatal(err)
	}
	f, err := r.Next()
	if err != nil {
		t.Fatal(err)
	}
	return string(f.Payload)
}

func TestParkForClaim(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "agent.sock")
	listen := func() (net.Listener, error) { return net.Listen("unix", sock) }
	listening := make(chan struct{})
	listenOnce := func() (net.Listener, error) {
		l, err := listen()
		close(listening)
		return l, err
	}

	var applied []proto.Claim
	fail := true
	apply := func(c proto.Claim) error {
		applied = append(applied, c)
		if fail {
			fail = false
			return errors.New("no eth0")
		}
		return nil
	}

	type result struct {
		claim proto.Claim
		err   error
	}
	done := make(chan result, 1)
	go func() {
		c, err := parkForClaim(listenOnce, apply)
		done <- result{c, err}
	}()
	<-listening

	ping := sendParked(t, sock, proto.Request{Op: proto.OpPing})
	var p proto.Ping
	if err := json.Unmarshal([]byte(ping), &p); err != nil || p.Stage != proto.StageTemplate {
		t.Fatalf("ping = %s", ping)
	}

	if got := sendParked(t, sock, proto.Request{Op: proto.OpExec}); !strings.Contains(got, proto.ErrUnknownOp) {
		t.Fatalf("exec while parked = %s", got)
	}
	if got := sendParked(t, sock, proto.Request{Op: proto.OpClaim}); !strings.Contains(got, proto.ErrBadRequest) {
		t.Fatalf("empty claim = %s", got)
	}

	claim := &proto.Claim{ID: "a", Hostname: "web", IP: "10.66.0.2/30", GW: "10.66.0.1", MAC: "06:00:0a:42:00:02", Seed: make([]byte, 64)}

	// a claim that fails to apply leaves the guest parked for another
	if got := sendParked(t, sock, proto.Request{Op: proto.OpClaim, Claim: claim}); !strings.Contains(got, proto.ErrInternal) {
		t.Fatalf("failed claim = %s", got)
	}
	if got := sendParked(t, sock, proto.Request{Op: proto.OpClaim, Claim: claim}); got != `{"ok":true}` {
		t.Fatalf("claim = %s", got)
	}

	res := <-done
	if res.err != nil || res.claim.Hostname != "web" || len(applied) != 2 {
		t.Fatalf("parkForClaim = %+v, %v; applied %d", res.claim, res.err, len(applied))
	}
	// the port is free for stage 2
	if _, err := net.Dial("unix", sock); err == nil {
		t.Fatal("the parked listener is still open")
	}
}

func TestClaimParamsNeverCarryTheTemplateFlag(t *testing.T) {
	p := claimParams(proto.Claim{ID: "a", Hostname: "web", IP: "10.66.0.2/30", GW: "10.66.0.1", IP6: "fd00::2/128", GW6: "fe80::1", DNS: []string{"1.1.1.1"}, ResetIdentity: true})
	if p.Template || p.Hostname != "web" || p.IP != "10.66.0.2/30" || p.IP6 != "fd00::2/128" || p.GW6 != "fe80::1" || !p.ResetIdentity || p.Raw["id"] != "a" {
		t.Fatalf("params = %+v", p)
	}
}

func TestReadHandoff(t *testing.T) {
	want := cmdline.Params{Hostname: "web", IP: "10.66.0.2/30", GW: "10.66.0.1", IP6: "fd00::2/128", GW6: "fe80::1", DNS: []string{"1.1.1.1"}}
	got := readHandoff([]string{"imp-agent", "stage2", want.Encode()})
	if got.Hostname != want.Hostname || got.IP != want.IP || got.IP6 != want.IP6 || got.GW6 != want.GW6 || got.DNS[0] != "1.1.1.1" {
		t.Fatalf("handoff = %+v", got)
	}
	// fail closed: no values means no network, not the template's cmdline
	for _, args := range [][]string{{"imp-agent", "stage2"}, {"imp-agent", "stage2", "{"}} {
		if p := readHandoff(args); p.IP != "" || p.Hostname != "" {
			t.Fatalf("%v gave %+v", args, p)
		}
	}
}

func TestAddEntropyRefusesAShortSeed(t *testing.T) {
	if err := addEntropy(make([]byte, 16)); err == nil {
		t.Fatal("a 16-byte seed passed")
	}
}
