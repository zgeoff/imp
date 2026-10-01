package proc

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func useAccounts(t *testing.T, passwd, group string) {
	t.Helper()
	dir := t.TempDir()
	p, g := filepath.Join(dir, "passwd"), filepath.Join(dir, "group")
	if err := os.WriteFile(p, []byte(passwd), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(g, []byte(group), 0o644); err != nil {
		t.Fatal(err)
	}
	oldP, oldG := passwdPath, groupPath
	passwdPath, groupPath = p, g
	t.Cleanup(func() { passwdPath, groupPath = oldP, oldG })
}

const (
	testPasswd = "root:x:0:0:root:/root:/bin/sh\n" +
		"imp:x:1000:1000::/home/imp:/bin/bash\n" +
		"svc:x:1001:1001::/srv:/bin/sh\n"
	testGroup = "root:x:0:\n" +
		"docker:x:999:imp,svc\n" +
		"imp:x:1000:\n" +
		"svc:x:1001:\n" +
		"wheel:x:10:other,imp\n" +
		"staff:x:50:\n"
)

func TestLookupUser(t *testing.T) {
	useAccounts(t, testPasswd, testGroup)
	tests := []struct {
		spec     string
		uid, gid uint32
		groups   []uint32
		home     string
	}{
		{"imp", 1000, 1000, []uint32{10, 999, 1000}, "/home/imp"},
		{"1000", 1000, 1000, []uint32{10, 999, 1000}, "/home/imp"},
		// An explicit group is the only group, as in runc.
		{"imp:staff", 1000, 50, []uint32{}, "/home/imp"},
		{"imp:7", 1000, 7, []uint32{}, "/home/imp"},
		{"svc", 1001, 1001, []uint32{999, 1001}, "/srv"},
		// A uid with no passwd entry gets no supplementary groups.
		{"4242", 4242, 4242, []uint32{}, "/"},
		{"4242:999", 4242, 999, []uint32{}, "/"},
	}
	for _, tt := range tests {
		t.Run(tt.spec, func(t *testing.T) {
			cred, home, err := LookupUser(tt.spec)
			if err != nil {
				t.Fatal(err)
			}
			if cred.Uid != tt.uid || cred.Gid != tt.gid || !slices.Equal(cred.Groups, tt.groups) || home != tt.home {
				t.Fatalf("LookupUser(%q) = %d:%d %v %q; want %d:%d %v %q",
					tt.spec, cred.Uid, cred.Gid, cred.Groups, home, tt.uid, tt.gid, tt.groups, tt.home)
			}
		})
	}
}

func TestLookupUserRoot(t *testing.T) {
	useAccounts(t, testPasswd, testGroup)
	for _, spec := range []string{"", "root", "0"} {
		if cred, home, err := LookupUser(spec); cred != nil || home != "/root" || err != nil {
			t.Errorf("LookupUser(%q) = %v, %q, %v; want inherited root", spec, cred, home, err)
		}
	}
}

func TestLookupUserErrors(t *testing.T) {
	tests := []struct {
		name, passwd, group, spec string
	}{
		{"unknown user", testPasswd, testGroup, "nobody"},
		{"unknown group", testPasswd, testGroup, "imp:nogroup"},
		// A malformed id must fail, never fall back to 0 (root).
		{"bad uid", "bad:x:abc:1000::/:/bin/sh\n", testGroup, "bad"},
		{"bad gid", "bad:x:1000:-1::/:/bin/sh\n", testGroup, "bad"},
		{"bad group id", testPasswd, "odd:x:zz:\n", "imp:odd"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			useAccounts(t, tt.passwd, tt.group)
			if cred, _, err := LookupUser(tt.spec); err == nil {
				t.Fatalf("LookupUser(%q) = %+v, want an error", tt.spec, cred)
			}
		})
	}
}

func TestLookupUserWithoutGroupFile(t *testing.T) {
	useAccounts(t, testPasswd, "")
	groupPath = filepath.Join(t.TempDir(), "missing")
	cred, _, err := LookupUser("imp")
	if err != nil || !slices.Equal(cred.Groups, []uint32{1000}) {
		t.Fatalf("LookupUser = %+v, %v; want only the primary group", cred, err)
	}
}

// TestLookupUserSkipsBadGroupLines checks that a malformed /etc/group line
// costs only that group, not every lookup.
func TestLookupUserSkipsBadGroupLines(t *testing.T) {
	useAccounts(t, testPasswd, "odd:x:zz:imp\nbroken\ndocker:x:999:imp\n")
	cred, _, err := LookupUser("imp")
	if err != nil || !slices.Equal(cred.Groups, []uint32{999, 1000}) {
		t.Fatalf("LookupUser = %+v, %v; want groups [999 1000]", cred, err)
	}
}

func TestLookupUserLongGroupLine(t *testing.T) {
	members := strings.Repeat("someone,", 20000) + "imp"
	useAccounts(t, testPasswd, "big:x:4000:"+members+"\n")
	cred, _, err := LookupUser("imp")
	if err != nil || !slices.Equal(cred.Groups, []uint32{1000, 4000}) {
		t.Fatalf("LookupUser = %+v, %v; want groups [1000 4000]", cred, err)
	}
}
