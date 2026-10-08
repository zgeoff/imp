package boot

import (
	"encoding/json"
	"errors"
	"net"
	"sync"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/cmdline"
	"github.com/zgeoff/imp/agent/internal/proto"
)

type parkResult struct {
	claim proto.Claim
	err   error
}

// startParked runs parkForClaim on a Unix socket named agent.sock in a
// fresh directory that becomes the test's working directory, and returns
// once it listens. The result arrives on the returned channel when a claim
// applies. Cleanup closes the listener, makes the next listen fail so the
// park loop ends, and waits for it.
func startParked(t *testing.T, apply func(proto.Claim) error) <-chan parkResult {
	t.Helper()
	// relative, from the test's own directory: a socket path past 108 bytes
	// fails to bind, and TMPDIR can be that long
	t.Chdir(t.TempDir())
	var mu sync.Mutex
	var current net.Listener
	stopped := false
	listening := make(chan struct{})
	var once sync.Once
	listen := func() (net.Listener, error) {
		mu.Lock()
		defer mu.Unlock()
		if stopped {
			return nil, errors.New("the test is over")
		}
		l, err := net.Listen("unix", "agent.sock")
		current = l
		once.Do(func() { close(listening) })
		return l, err
	}
	result := make(chan parkResult, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		c, err := parkForClaim(listen, apply)
		result <- parkResult{c, err}
	}()
	t.Cleanup(func() {
		mu.Lock()
		stopped = true
		if current != nil {
			current.Close()
		}
		mu.Unlock()
		<-finished
	})
	<-listening
	return result
}

// sendParked sends one request to the parked listener and returns the
// reply's raw JSON.
func sendParked(t *testing.T, req proto.Request) string {
	t.Helper()
	c, err := net.Dial("unix", "agent.sock")
	assert.NilError(t, err)
	t.Cleanup(func() { c.Close() })
	assert.NilError(t, proto.NewWriter(c).WriteJSON(proto.TypeRequest, req))
	f, err := proto.NewReader(c).Next()
	assert.NilError(t, err)
	return string(f.Payload)
}

// errorCode decodes an error response's code.
func errorCode(t *testing.T, reply string) string {
	t.Helper()
	var r proto.ErrorResponse
	assert.NilError(t, json.Unmarshal([]byte(reply), &r))
	assert.Assert(t, r.Error != nil, "not an error response: %s", reply)
	return r.Error.Code
}

func validClaim() *proto.Claim {
	return &proto.Claim{ID: "a", Hostname: "web", IP: "10.66.0.2/30", GW: "10.66.0.1", MAC: "06:00:0a:42:00:02", Seed: make([]byte, 64)}
}

func TestStartParkedEndsTheParkLoopAtCleanup(t *testing.T) {
	var result <-chan parkResult

	t.Run("parked", func(t *testing.T) {
		result = startParked(t, func(proto.Claim) error { return nil })
	})

	select {
	case r := <-result:
		assert.ErrorContains(t, r.err, "the test is over")
	default:
		t.Fatal("the park loop was still running after cleanup")
	}
}

func TestParkForClaimAnswersPingAsABootTemplate(t *testing.T) {
	startParked(t, func(proto.Claim) error { return nil })

	reply := sendParked(t, proto.Request{Op: proto.OpPing})

	var p proto.Ping
	assert.NilError(t, json.Unmarshal([]byte(reply), &p))
	assert.Equal(t, p.Stage, proto.StageTemplate)
}

func TestParkForClaimRefusesAnyOtherOpAsUnknown(t *testing.T) {
	startParked(t, func(proto.Claim) error { return nil })

	reply := sendParked(t, proto.Request{Op: proto.OpExec})

	assert.Equal(t, errorCode(t, reply), proto.ErrUnknownOp)
}

func TestParkForClaimRefusesAClaimWithoutAHostnameAndIP(t *testing.T) {
	startParked(t, func(proto.Claim) error { return nil })

	reply := sendParked(t, proto.Request{Op: proto.OpClaim})

	assert.Equal(t, errorCode(t, reply), proto.ErrBadRequest)
}

// A claim that fails to apply leaves the guest parked for another, and the
// next claim that applies ends the park.
func TestParkForClaimStaysParkedAfterAClaimFailsToApply(t *testing.T) {
	var applied []proto.Claim
	fail := true
	result := startParked(t, func(c proto.Claim) error {
		applied = append(applied, c)
		if fail {
			fail = false
			return errors.New("no eth0")
		}
		return nil
	})
	failed := sendParked(t, proto.Request{Op: proto.OpClaim, Claim: validClaim()})

	reply := sendParked(t, proto.Request{Op: proto.OpClaim, Claim: validClaim()})

	res := <-result
	assert.Check(t, cmp.Equal(errorCode(t, failed), proto.ErrInternal))
	assert.Check(t, cmp.Equal(reply, `{"ok":true}`))
	assert.Check(t, res.err)
	assert.Check(t, cmp.DeepEqual(res.claim, *validClaim()))
	assert.Check(t, cmp.Len(applied, 2))
}

// Once a claim applies, the listener closes so the server can take the port.
func TestParkForClaimClosesTheListenerAfterAClaim(t *testing.T) {
	result := startParked(t, func(proto.Claim) error { return nil })
	sendParked(t, proto.Request{Op: proto.OpClaim, Claim: validClaim()})
	<-result

	_, err := net.Dial("unix", "agent.sock")

	// the closed listener unlinks its socket, which is the test's own
	assert.Check(t, cmp.ErrorIs(err, syscall.ENOENT), "the parked listener is still open")
}

// A snapshot restore resets the vsock transport: the park listens again,
// and a listen that then fails ends it with that error.
func TestParkForClaimReturnsTheErrorWhenListeningAgainFails(t *testing.T) {
	t.Chdir(t.TempDir())
	refused := errors.New("no vsock")
	listens := 0
	listen := func() (net.Listener, error) {
		listens++
		if listens > 1 {
			return nil, refused
		}
		l, err := net.Listen("unix", "agent.sock")
		if err == nil {
			// the transport resets under the first listener at once
			l.Close()
		}
		return l, err
	}

	_, err := parkForClaim(listen, func(proto.Claim) error { return nil })

	assert.Check(t, cmp.ErrorIs(err, refused))
	assert.Check(t, cmp.Equal(listens, 2))
}

func TestClaimParamsCarryTheClaimAndNeverTheTemplateFlag(t *testing.T) {
	p := claimParams(proto.Claim{ID: "a", Hostname: "web", IP: "10.66.0.2/30", GW: "10.66.0.1", IP6: "fd00::2/128", GW6: "fe80::1", DNS: []string{"1.1.1.1"}, ResetIdentity: true})

	assert.DeepEqual(t, p, cmdline.Params{
		Hostname:      "web",
		IP:            "10.66.0.2/30",
		GW:            "10.66.0.1",
		IP6:           "fd00::2/128",
		GW6:           "fe80::1",
		DNS:           []string{"1.1.1.1"},
		ResetIdentity: true,
		Raw:           map[string]string{"id": "a"},
	})
}

func TestAddEntropyRefusesASeedShorterThan32Bytes(t *testing.T) {
	err := addEntropy(make([]byte, 16))

	assert.ErrorContains(t, err, "a seed of 16 bytes; want at least 32")
}

func TestWaitForDiskSizeSkipsTheWaitForZero(t *testing.T) {
	err := waitForDiskSize(func() (uint64, error) { return 0, errors.New("no such device") }, 0, time.Millisecond)

	assert.NilError(t, err)
}

func TestWaitForDiskSizeFailsAtTheDeadlineForADeviceThatNeverAnswers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()

		err := waitForDiskSize(func() (uint64, error) { return 0, errors.New("no such device") }, 4096, 10*time.Millisecond)

		assert.Check(t, cmp.ErrorContains(err, "no such device"))
		assert.Check(t, time.Since(start) >= 10*time.Millisecond, "gave up after %s", time.Since(start))
	})
}

// The placeholder's 1 MiB, then the grown size once the config interrupt
// lands, in whole sectors.
func TestWaitForDiskSizeReturnsOnceTheDiskGrows(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		reads := 0
		growing := func() (uint64, error) {
			reads++
			if reads < 5 {
				return 1 << 20, nil
			}
			return 6<<30 - 512, nil
		}

		err := waitForDiskSize(growing, 6<<30-100, time.Second)

		assert.Check(t, err)
		assert.Check(t, cmp.Equal(reads, 5))
	})
}

func TestWaitForDiskSizeReportsTheSizeOfADiskThatNeverGrew(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		err := waitForDiskSize(func() (uint64, error) { return 1 << 20, nil }, 6<<30, 20*time.Millisecond)

		assert.ErrorContains(t, err, "reports 1048576 bytes")
	})
}
