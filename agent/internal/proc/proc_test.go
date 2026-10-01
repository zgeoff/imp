package proc

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestMerge(t *testing.T) {
	tests := []struct {
		name        string
		base, extra []string
		want        []string
	}{
		{"empty", nil, nil, []string{}},
		{"add", []string{"A=1"}, []string{"B=2"}, []string{"A=1", "B=2"}},
		{"replace in place", []string{"A=1", "B=2"}, []string{"A=3"}, []string{"A=3", "B=2"}},
		{"last wins", nil, []string{"A=1", "A=2"}, []string{"A=2"}},
		{"value with =", []string{"A=x=y"}, []string{"B="}, []string{"A=x=y", "B="}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base := slices.Clone(tt.base)
			got := Merge(tt.base, tt.extra)
			if !slices.Equal(got, tt.want) {
				t.Fatalf("Merge = %q, want %q", got, tt.want)
			}
			if !slices.Equal(base, tt.base) {
				t.Fatalf("Merge changed base to %q", tt.base)
			}
		})
	}
}

func TestGet(t *testing.T) {
	env := []string{"A=1", "B=2", "A=3", "C"}
	for key, want := range map[string]string{"A": "3", "B": "2", "C": "", "D": ""} {
		if got := Get(env, key); got != want {
			t.Errorf("Get(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestLookPath(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	write := func(p string, mode os.FileMode) {
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(a, "noexec"), 0o644)
	write(filepath.Join(b, "noexec"), 0o755)
	write(filepath.Join(a, "tool"), 0o755)
	write(filepath.Join(b, "tool"), 0o755)
	if err := os.Mkdir(filepath.Join(a, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	env := []string{"PATH=" + a + ":" + b}

	tests := []struct {
		file string
		want string
		err  bool
	}{
		{"tool", filepath.Join(a, "tool"), false},
		// A non-executable match is skipped, as a shell would.
		{"noexec", filepath.Join(b, "noexec"), false},
		{"dir", "", true},
		{"missing", "", true},
		{filepath.Join(a, "tool"), filepath.Join(a, "tool"), false},
		{filepath.Join(a, "noexec"), "", true},
	}
	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			got, err := LookPath(tt.file, env)
			if tt.err {
				if err == nil {
					t.Fatalf("LookPath = %q, want an error", got)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("LookPath = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestLookPathUsesEnvPath(t *testing.T) {
	if _, err := LookPath("sh", []string{"PATH=" + t.TempDir()}); err == nil {
		t.Fatal("found sh outside the given PATH")
	}
}
