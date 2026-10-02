// Package imagecfg loads /etc/imp/image.json, the OCI config (Env,
// WorkingDir, User) that the image builder copies into the rootfs.
package imagecfg

import (
	"encoding/json"
	"errors"
	"io/fs"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/proc"
)

const Path = "/etc/imp/image.json"

// Config is the default context for exec and services.
type Config struct {
	Env     []string `json:"env"`
	Workdir string   `json:"workdir"`
	User    string   `json:"user"`
}

var defaultEnv = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/root",
	"TERM=xterm-256color",
}

// Load reads Path in fsys, the user's root. A missing file gives the
// defaults; image env entries override the defaults key by key.
func Load(fsys fsroot.FS) (Config, error) {
	return load(fsys, Path)
}

func load(fsys fsroot.FS, path string) (Config, error) {
	c := Config{}
	b, err := fsys.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return Config{Env: defaultEnv}, err
	default:
		if err := json.Unmarshal(b, &c); err != nil {
			return Config{Env: defaultEnv}, err
		}
	}
	c.Env = proc.Merge(defaultEnv, c.Env)
	return c, nil
}
