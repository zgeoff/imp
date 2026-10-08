package proc

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

// useAccounts points the account lookups at passwd and group files holding
// the given contents, for the rest of the test.
func useAccounts(t *testing.T, passwd, group string) {
	t.Helper()
	dir := t.TempDir()
	p, g := filepath.Join(dir, "passwd"), filepath.Join(dir, "group")
	assert.NilError(t, os.WriteFile(p, []byte(passwd), 0o644))
	assert.NilError(t, os.WriteFile(g, []byte(group), 0o644))
	oldP, oldG := passwdPath, groupPath
	passwdPath, groupPath = p, g
	t.Cleanup(func() { passwdPath, groupPath = oldP, oldG })
}

// The account files most cases resolve against: imp is in docker and
// wheel, svc only in docker. They are immutable inputs; each test installs
// them itself through useAccounts.
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

func TestLookupUserResolvesTheCredentialsAndHomeOfASpec(t *testing.T) {
	for _, tc := range []struct {
		spec string
		cred *syscall.Credential
		home string
	}{
		{"imp", &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{10, 999, 1000}}, "/home/imp"},
		{"1000", &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{10, 999, 1000}}, "/home/imp"},
		// An explicit group is the only group, as in runc.
		{"imp:staff", &syscall.Credential{Uid: 1000, Gid: 50, Groups: []uint32{}}, "/home/imp"},
		{"imp:7", &syscall.Credential{Uid: 1000, Gid: 7, Groups: []uint32{}}, "/home/imp"},
		{"svc", &syscall.Credential{Uid: 1001, Gid: 1001, Groups: []uint32{999, 1001}}, "/srv"},
		// A uid with no passwd entry gets no supplementary groups.
		{"4242", &syscall.Credential{Uid: 4242, Gid: 4242, Groups: []uint32{}}, "/"},
		{"4242:999", &syscall.Credential{Uid: 4242, Gid: 999, Groups: []uint32{}}, "/"},
	} {
		t.Run(tc.spec, func(t *testing.T) {
			useAccounts(t, testPasswd, testGroup)

			cred, home, err := LookupUser(tc.spec)

			assert.NilError(t, err)
			assert.Check(t, cmp.DeepEqual(cred, tc.cred))
			assert.Check(t, cmp.Equal(home, tc.home))
		})
	}
}

func TestLookupUserLeavesRootToInheritTheAgentsCredentials(t *testing.T) {
	for _, spec := range []string{"", "root", "0"} {
		t.Run("spec "+spec, func(t *testing.T) {
			useAccounts(t, testPasswd, testGroup)

			cred, home, err := LookupUser(spec)

			assert.NilError(t, err)
			assert.Check(t, cmp.Nil(cred))
			assert.Check(t, cmp.Equal(home, "/root"))
		})
	}
}

// The error text is the EXEC_FAILED message the host shows. A failed lookup
// gives no credential and no home, so it never falls back to root.
func TestLookupUserFailsForASpecItCannotResolve(t *testing.T) {
	for _, tc := range []struct {
		name, passwd, group, spec string
		// want is the error text, given the paths the test installed
		want func(passwd, group string) string
	}{
		{name: "unknown user", passwd: testPasswd, group: testGroup, spec: "nobody",
			want: func(string, string) string { return `unknown user "nobody"` }},
		{name: "unknown group", passwd: testPasswd, group: testGroup, spec: "imp:nogroup",
			want: func(string, string) string { return `unknown group "nogroup"` }},
		// A malformed id must fail, never fall back to 0 (root).
		{name: "bad uid", passwd: "bad:x:abc:1000::/:/bin/sh\n", group: testGroup, spec: "bad",
			want: func(passwd, _ string) string { return passwd + `: bad: bad id "abc"` }},
		{name: "bad gid", passwd: "bad:x:1000:-1::/:/bin/sh\n", group: testGroup, spec: "bad",
			want: func(passwd, _ string) string { return passwd + `: bad: bad id "-1"` }},
		{name: "bad group id", passwd: testPasswd, group: "odd:x:zz:\n", spec: "imp:odd",
			want: func(_, group string) string { return group + `: odd: bad id "zz"` }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			useAccounts(t, tc.passwd, tc.group)

			cred, home, err := LookupUser(tc.spec)

			assert.Check(t, cmp.Error(err, tc.want(passwdPath, groupPath)))
			assert.Check(t, cmp.Nil(cred))
			assert.Check(t, cmp.Equal(home, ""))
		})
	}
}

func TestLookupUserGivesOnlyThePrimaryGroupWithoutAGroupFile(t *testing.T) {
	useAccounts(t, testPasswd, "")
	groupPath = filepath.Join(t.TempDir(), "missing")

	cred, _, err := LookupUser("imp")

	assert.NilError(t, err)
	assert.DeepEqual(t, cred.Groups, []uint32{1000})
}

// A malformed /etc/group line costs only that group, not every lookup.
func TestLookupUserSkipsMalformedGroupLines(t *testing.T) {
	useAccounts(t, testPasswd, "odd:x:zz:imp\nbroken\ndocker:x:999:imp\n")

	cred, _, err := LookupUser("imp")

	assert.NilError(t, err)
	assert.DeepEqual(t, cred.Groups, []uint32{999, 1000})
}

func TestLookupUserReadsAGroupLineLongerThanTheScannerDefault(t *testing.T) {
	members := strings.Repeat("someone,", 20000) + "imp"
	useAccounts(t, testPasswd, "big:x:4000:"+members+"\n")

	cred, _, err := LookupUser("imp")

	assert.NilError(t, err)
	assert.DeepEqual(t, cred.Groups, []uint32{1000, 4000})
}
