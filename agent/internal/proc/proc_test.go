package proc

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestMergeAddsOrReplacesEachKeyWithoutChangingTheBase(t *testing.T) {
	for _, tc := range []struct {
		name        string
		base, extra []string
		want        []string
	}{
		{name: "empty", base: nil, extra: nil, want: []string{}},
		{name: "add", base: []string{"A=1"}, extra: []string{"B=2"}, want: []string{"A=1", "B=2"}},
		{name: "replace in place", base: []string{"A=1", "B=2"}, extra: []string{"A=3"}, want: []string{"A=3", "B=2"}},
		{name: "last wins", base: nil, extra: []string{"A=1", "A=2"}, want: []string{"A=2"}},
		{name: "value with =", base: []string{"A=x=y"}, extra: []string{"B="}, want: []string{"A=x=y", "B="}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := slices.Clone(tc.base)

			got := Merge(tc.base, tc.extra)

			assert.Check(t, cmp.DeepEqual(got, tc.want))
			assert.Check(t, cmp.DeepEqual(tc.base, before), "Merge changed its base")
		})
	}
}

func TestGetReturnsTheLastValueOfAKey(t *testing.T) {
	for _, tc := range []struct {
		name string
		key  string
		want string
	}{
		{name: "repeated key", key: "A", want: "3"},
		{name: "single key", key: "B", want: "2"},
		{name: "entry without =", key: "C", want: ""},
		{name: "missing key", key: "D", want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := []string{"A=1", "B=2", "A=3", "C"}

			assert.Equal(t, Get(env, tc.key), tc.want)
		})
	}
}

// pathDirs makes two PATH directories, a then b, holding the binaries the
// LookPath cases resolve.
func pathDirs(t *testing.T) (a, b string) {
	t.Helper()
	a, b = t.TempDir(), t.TempDir()
	for _, f := range []struct {
		path string
		mode os.FileMode
	}{
		{filepath.Join(a, "noexec"), 0o644},
		{filepath.Join(b, "noexec"), 0o755},
		{filepath.Join(a, "tool"), 0o755},
		{filepath.Join(b, "tool"), 0o755},
	} {
		assert.NilError(t, os.WriteFile(f.path, []byte("#!/bin/sh\n"), f.mode))
	}
	assert.NilError(t, os.Mkdir(filepath.Join(a, "dir"), 0o755))
	return a, b
}

func TestLookPathFindsTheFirstExecutableMatch(t *testing.T) {
	for _, tc := range []struct {
		name string
		file func(a, b string) string
		want func(a, b string) string
	}{
		{
			name: "first PATH entry",
			file: func(a, b string) string { return "tool" },
			want: func(a, b string) string { return filepath.Join(a, "tool") },
		},
		{
			// A non-executable match is skipped, as a shell would.
			name: "non-executable match skipped",
			file: func(a, b string) string { return "noexec" },
			want: func(a, b string) string { return filepath.Join(b, "noexec") },
		},
		{
			name: "path with a slash",
			file: func(a, b string) string { return filepath.Join(a, "tool") },
			want: func(a, b string) string { return filepath.Join(a, "tool") },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, b := pathDirs(t)

			got, err := LookPath(tc.file(a, b), []string{"PATH=" + a + ":" + b})

			assert.NilError(t, err)
			assert.Equal(t, got, tc.want(a, b))
		})
	}
}

func TestLookPathFailsWithoutAnExecutableMatch(t *testing.T) {
	for _, tc := range []struct {
		name string
		file func(a string) string
	}{
		{name: "directory", file: func(a string) string { return "dir" }},
		{name: "missing", file: func(a string) string { return "missing" }},
		{name: "non-executable path with a slash", file: func(a string) string { return filepath.Join(a, "noexec") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, b := pathDirs(t)

			got, err := LookPath(tc.file(a), []string{"PATH=" + a + ":" + b})

			assert.Assert(t, err != nil, "LookPath = %q, want an error", got)
		})
	}
}

func TestLookPathSearchesOnlyThePathOfTheGivenEnv(t *testing.T) {
	got, err := LookPath("sh", []string{"PATH=" + t.TempDir()})

	assert.Assert(t, err != nil, "found sh at %q outside the given PATH", got)
}
