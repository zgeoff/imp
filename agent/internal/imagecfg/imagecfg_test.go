package imagecfg

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

func TestLoadMergesTheImageConfigOverTheDefaults(t *testing.T) {
	for _, tc := range []struct {
		name string
		file string // "" for no file
		want Config
	}{
		{
			name: "no file gives the defaults",
			want: Config{Env: []string{
				"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				"HOME=/root",
				"TERM=xterm-256color",
			}},
		},
		{
			name: "image env overrides defaults key by key",
			file: `{"env":["PATH=/opt/bin","LANG=C.UTF-8"],"workdir":"/app","user":"1000:1000"}`,
			want: Config{
				Env: []string{
					"PATH=/opt/bin",
					"HOME=/root",
					"TERM=xterm-256color",
					"LANG=C.UTF-8",
				},
				Workdir: "/app",
				User:    "1000:1000",
			},
		},
		{
			name: "an empty object gives the defaults",
			file: `{}`,
			want: Config{Env: []string{
				"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				"HOME=/root",
				"TERM=xterm-256color",
			}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "image.json")
			if tc.file != "" {
				assert.NilError(t, os.WriteFile(path, []byte(tc.file), 0o644))
			}

			got, err := load(fsroot.Host, path)

			assert.NilError(t, err)
			assert.DeepEqual(t, got, tc.want)
		})
	}
}

func TestLoadFallsBackToTheDefaultsForBrokenJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "image.json")
	assert.NilError(t, os.WriteFile(path, []byte(`{"env":`), 0o644))

	got, err := load(fsroot.Host, path)

	var syntaxErr *json.SyntaxError
	assert.Check(t, errors.As(err, &syntaxErr), "err = %v, want a *json.SyntaxError", err)
	assert.Check(t, cmp.DeepEqual(got, Config{Env: []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"TERM=xterm-256color",
	}}))
}

// A directory where the file should be: the read fails and the defaults
// remain.
func TestLoadFallsBackToTheDefaultsForAnUnreadableFile(t *testing.T) {
	got, err := load(fsroot.Host, t.TempDir())

	assert.Check(t, cmp.ErrorIs(err, syscall.EISDIR))
	assert.Check(t, cmp.DeepEqual(got, Config{Env: []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"TERM=xterm-256color",
	}}))
}

func TestLiveGetReturnsTheConfigLastSet(t *testing.T) {
	l := NewLive(Config{User: "root"})

	l.Set(Config{User: "1000:1000", Workdir: "/app"})

	assert.DeepEqual(t, l.Get(), Config{User: "1000:1000", Workdir: "/app"})
}
