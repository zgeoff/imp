package boot

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

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
	// relative, from the test's own directory: a socket path past 108 bytes
	// fails to bind, and TMPDIR can be that long
	t.Chdir(t.TempDir())
	sock := "agent.sock"
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
	// the port is free for the server
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

func TestAddEntropyRefusesAShortSeed(t *testing.T) {
	if err := addEntropy(make([]byte, 16)); err == nil {
		t.Fatal("a 16-byte seed passed")
	}
}

func TestWaitForDiskSize(t *testing.T) {
	noDevice := func() (uint64, error) { return 0, errors.New("no such device") }
	if err := waitForDiskSize(noDevice, 0, time.Millisecond); err != nil {
		t.Fatalf("want 0 skips the wait: %v", err)
	}
	if err := waitForDiskSize(noDevice, 4096, 10*time.Millisecond); err == nil {
		t.Fatal("a device that never answers passed")
	}

	// the placeholder's 1 MiB, then the grown size once the config
	// interrupt lands, in whole sectors
	reads := 0
	growing := func() (uint64, error) {
		reads++
		if reads < 5 {
			return 1 << 20, nil
		}
		return 6<<30 - 512, nil
	}
	if err := waitForDiskSize(growing, 6<<30-100, time.Second); err != nil {
		t.Fatalf("a disk that grew failed the wait: %v", err)
	}
	if reads != 5 {
		t.Fatalf("read the size %d times; want 5", reads)
	}

	small := func() (uint64, error) { return 1 << 20, nil }
	err := waitForDiskSize(small, 6<<30, 20*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "reports 1048576 bytes") {
		t.Fatalf("a disk that never grew: %v", err)
	}
}
