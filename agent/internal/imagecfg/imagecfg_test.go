package imagecfg

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		file    string // "" for no file
		want    Config
		wantErr bool
	}{
		{name: "no file gives the defaults", want: Config{Env: defaultEnv}},
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
		{name: "an empty object gives the defaults", file: `{}`, want: Config{Env: defaultEnv}},
		{name: "broken json falls back to the defaults", file: `{"env":`,
			want: Config{Env: defaultEnv}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "image.json")
			if tt.file != "" {
				if err := os.WriteFile(path, []byte(tt.file), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			got, err := load(path)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestLoadUnreadable(t *testing.T) {
	// a directory where the file should be: read fails, defaults remain
	got, err := load(t.TempDir())
	if err == nil || !reflect.DeepEqual(got, Config{Env: defaultEnv}) {
		t.Fatalf("got %+v, %v", got, err)
	}
}
