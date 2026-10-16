package dropcaps

import (
	"syscall"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestArgvNamesTheAgentFdTheUserAndTheCommand(t *testing.T) {
	cred := &syscall.Credential{Uid: 1000, Gid: 100, Groups: []uint32{27, 999}}

	got := Argv(3, cred, "/usr/bin/claude", []string{"claude", "--resume"})

	assert.DeepEqual(t, got, []string{"imp-agent", Command, "3", "1000:100:27,999", "/usr/bin/claude", "claude", "--resume"})
}

func TestArgvMarksRootAndNoAgentFdEmpty(t *testing.T) {
	got := Argv(-1, nil, "/bin/sh", []string{"sh"})

	assert.DeepEqual(t, got, []string{"imp-agent", Command, "-", "", "/bin/sh", "sh"})
}

func TestParseCredReadsWhatArgvWrites(t *testing.T) {
	cred := &syscall.Credential{Uid: 1000, Gid: 100, Groups: []uint32{27, 999}}

	got, err := parseCred(Argv(-1, cred, "/bin/sh", nil)[3])

	assert.NilError(t, err)
	assert.DeepEqual(t, got, cred)
}

func TestParseCredReadsAUserWithNoGroupsAsNoGroups(t *testing.T) {
	got, err := parseCred("1000:100:")

	assert.NilError(t, err)
	assert.DeepEqual(t, got, &syscall.Credential{Uid: 1000, Gid: 100, Groups: []uint32{}})
}

func TestParseCredRefusesAMalformedCred(t *testing.T) {
	for name, cred := range map[string]string{
		"no groups field": "1000:100",
		"a named user":    "imp:100:",
		"a named group":   "1000:100:docker",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := parseCred(cred)

			assert.Check(t, cmp.ErrorContains(err, cred))
		})
	}
}

func TestRunHelperRefusesTooFewArguments(t *testing.T) {
	err := RunHelper([]string{"-", "", "/bin/sh"})

	assert.Error(t, err, "usage: imp-agent drop-sys-admin <agent fd> <cred> <path> <argv...>")
}
