package services

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

func TestNextBackoffDoublesFromOneSecondUpToTheSixtySecondCap(t *testing.T) {
	var got []time.Duration
	backoff := minBackoff
	for range 9 {
		var wait time.Duration
		wait, backoff = nextBackoff(backoff, 0)
		got = append(got, wait)
	}

	assert.DeepEqual(t, got, []time.Duration{
		1 * time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second,
		32 * time.Second, 60 * time.Second, 60 * time.Second, 60 * time.Second,
	})
}

func TestNextBackoffResetsAfterAStableRun(t *testing.T) {
	for _, tc := range []struct {
		name       string
		ran        time.Duration
		wait, next time.Duration
	}{
		{name: "just short of stable keeps doubling", ran: stableAfter - time.Millisecond, wait: 32 * time.Second, next: maxBackoff},
		{name: "exactly stable resets", ran: stableAfter, wait: minBackoff, next: 2 * minBackoff},
		{name: "an hour resets", ran: time.Hour, wait: minBackoff, next: 2 * minBackoff},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wait, next := nextBackoff(32*time.Second, tc.ran)

			assert.Check(t, cmp.Equal(wait, tc.wait))
			assert.Check(t, cmp.Equal(next, tc.next))
		})
	}
}

func TestShouldRestartAppliesTheRestartPolicy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		policy string
		failed bool
		want   bool
	}{
		{name: "always after a clean exit", policy: "always", failed: false, want: true},
		{name: "always after a failure", policy: "always", failed: true, want: true},
		{name: "on-failure after a clean exit", policy: "on-failure", failed: false, want: false},
		{name: "on-failure after a failure", policy: "on-failure", failed: true, want: true},
		{name: "never after a clean exit", policy: "never", failed: false, want: false},
		{name: "never after a failure", policy: "never", failed: true, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, shouldRestart(tc.policy, tc.failed), tc.want)
		})
	}
}

func TestReadDefTakesTheNameFromTheFileAndFillsTheDefaults(t *testing.T) {
	for _, tc := range []struct {
		name string
		file string
		body string
		want Def
	}{
		{
			name: "defaults",
			file: "web.json",
			body: `{"argv":["httpd"]}`,
			want: Def{Name: "web", Argv: []string{"httpd"}, Restart: "always", Source: "image"},
		},
		{
			// the file name is the name; a name field cannot claim another
			name: "a name field is ignored",
			file: "x.json",
			body: `{"name":"api","argv":["api"],"restart":"on-failure","source":"api"}`,
			want: Def{Name: "x", Argv: []string{"api"}, Restart: "on-failure", Source: "api"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), tc.file)
			assert.NilError(t, os.WriteFile(p, []byte(tc.body), 0o644))

			got, err := readDef(fsroot.Host, p)

			assert.NilError(t, err)
			assert.DeepEqual(t, got, tc.want)
		})
	}
}

// The messages are contract: Add and Restart hand them back as the
// BAD_REQUEST message.
func TestReadDefRejectsADefinitionTheSupervisorCannotRun(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{name: "empty argv", body: `{"argv":[]}`, want: "argv is empty"},
		{name: "unknown restart policy", body: `{"argv":["a"],"restart":"sometimes"}`, want: `restart "sometimes": want always, on-failure or never`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "svc.json")
			assert.NilError(t, os.WriteFile(p, []byte(tc.body), 0o644))

			_, err := readDef(fsroot.Host, p)

			assert.Error(t, err, tc.want)
		})
	}
}

func TestReadDefRejectsAFileThatIsNotJSON(t *testing.T) {
	p := filepath.Join(t.TempDir(), "syntax.json")
	assert.NilError(t, os.WriteFile(p, []byte(`{`), 0o644))

	_, err := readDef(fsroot.Host, p)

	var syntax *json.SyntaxError
	assert.Assert(t, errors.As(err, &syntax), "err = %v, want a JSON syntax error", err)
}

func TestReadDefReportsAMissingFileAsNotExist(t *testing.T) {
	_, err := readDef(fsroot.Host, filepath.Join(t.TempDir(), "missing.json"))

	assert.ErrorIs(t, err, fs.ErrNotExist)
}
