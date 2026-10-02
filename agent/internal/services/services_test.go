package services

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestBackoffSequence(t *testing.T) {
	var got []time.Duration
	backoff := minBackoff
	for range 9 {
		var wait time.Duration
		wait, backoff = nextBackoff(backoff, 0)
		got = append(got, wait)
	}
	want := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60, 60}
	for i := range want {
		if got[i] != want[i]*time.Second {
			t.Fatalf("waits %v, want %v seconds", got, want)
		}
	}
}

func TestBackoffResetsAfterStableRun(t *testing.T) {
	tests := []struct {
		ran        time.Duration
		wait, next time.Duration
	}{
		{stableAfter - time.Millisecond, 32 * time.Second, maxBackoff},
		{stableAfter, minBackoff, 2 * minBackoff},
		{time.Hour, minBackoff, 2 * minBackoff},
	}
	for _, tt := range tests {
		wait, next := nextBackoff(32*time.Second, tt.ran)
		if wait != tt.wait || next != tt.next {
			t.Errorf("nextBackoff(32s, %s) = %s, %s; want %s, %s", tt.ran, wait, next, tt.wait, tt.next)
		}
	}
}

func TestShouldRestart(t *testing.T) {
	tests := []struct {
		policy string
		failed bool
		want   bool
	}{
		{"always", false, true},
		{"always", true, true},
		{"on-failure", false, false},
		{"on-failure", true, true},
		{"never", false, false},
		{"never", true, false},
	}
	for _, tt := range tests {
		if got := shouldRestart(tt.policy, tt.failed); got != tt.want {
			t.Errorf("shouldRestart(%q, %v) = %v, want %v", tt.policy, tt.failed, got, tt.want)
		}
	}
}

func TestReadDef(t *testing.T) {
	tests := []struct {
		file, body string
		want       Def
		err        bool
	}{
		{"web.json", `{"argv":["httpd"]}`, Def{Name: "web", Argv: []string{"httpd"}, Restart: "always", Source: "image"}, false},
		// the file name is the name; a name field cannot claim another
		{"x.json", `{"name":"api","argv":["api"],"restart":"on-failure","source":"api"}`,
			Def{Name: "x", Argv: []string{"api"}, Restart: "on-failure", Source: "api"}, false},
		{"empty.json", `{"argv":[]}`, Def{}, true},
		{"bad.json", `{"argv":["a"],"restart":"sometimes"}`, Def{}, true},
		{"syntax.json", `{`, Def{}, true},
	}
	dir := t.TempDir()
	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			p := filepath.Join(dir, tt.file)
			if err := os.WriteFile(p, []byte(tt.body), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := readDef(p)
			if tt.err {
				if err == nil {
					t.Fatalf("readDef = %+v, want an error", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("readDef = %+v, want %+v", got, tt.want)
			}
		})
	}
}
