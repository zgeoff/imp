package cmdline

import (
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestParseReadsEveryImpParameterAndKeepsQuotedValuesWhole(t *testing.T) {
	line := `console=ttyS0 reboot=k root=/dev/vdb ro init=/imp-agent imp.hostname=smoke ` +
		`imp.ip=10.66.0.2/30 imp.gw=10.66.0.1 imp.dns=1.1.1.1,8.8.8.8 imp.id="a b" ` +
		"virtio_mmio.device=4K@0xd0000000:5\n"

	p := Parse(line)

	assert.DeepEqual(t, p, Params{
		Hostname: "smoke",
		IP:       "10.66.0.2/30",
		GW:       "10.66.0.1",
		DNS:      []string{"1.1.1.1", "8.8.8.8"},
		Raw: map[string]string{
			"hostname": "smoke",
			"ip":       "10.66.0.2/30",
			"gw":       "10.66.0.1",
			"dns":      "1.1.1.1,8.8.8.8",
			"id":       "a b",
		},
	})
}

func TestParseReturnsNoParametersForAnEmptyLine(t *testing.T) {
	p := Parse("")

	assert.DeepEqual(t, p, Params{Raw: map[string]string{}})
}

func TestParseDropsEmptyDNSEntries(t *testing.T) {
	p := Parse("imp.dns=,1.1.1.1,,")

	assert.DeepEqual(t, p.DNS, []string{"1.1.1.1"})
}

func TestParseSetsResetIdentityOnlyWhenTheParameterIsOne(t *testing.T) {
	for _, tc := range []struct {
		name string
		line string
		want bool
	}{
		{name: "absent", line: "imp.hostname=a", want: false},
		{name: "one", line: "imp.hostname=a imp.reset_identity=1", want: true},
		{name: "zero", line: "imp.hostname=a imp.reset_identity=0", want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, Parse(tc.line).ResetIdentity, tc.want)
		})
	}
}

func TestParseSetsTemplateOnlyWhenTheParameterIsOne(t *testing.T) {
	for _, tc := range []struct {
		name string
		line string
		want bool
	}{
		{name: "absent", line: "imp.hostname=a", want: false},
		{name: "one", line: "imp.hostname=a imp.template=1", want: true},
		{name: "zero", line: "imp.hostname=a imp.template=0", want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, Parse(tc.line).Template, tc.want)
		})
	}
}

func TestParseReadsTheIPv6AddressAndGateway(t *testing.T) {
	p := Parse("imp.ip=10.66.0.2/30 imp.ip6=fd12:3456:789a::a42:2/128 imp.gw6=fe80::1")

	assert.Check(t, cmp.Equal(p.IP6, "fd12:3456:789a::a42:2/128"))
	assert.Check(t, cmp.Equal(p.GW6, "fe80::1"))
}

func TestParseLeavesIPv6EmptyWhenTheHostGivesNone(t *testing.T) {
	p := Parse("imp.ip=10.66.0.2/30")

	assert.Check(t, cmp.Equal(p.IP6, ""))
	assert.Check(t, cmp.Equal(p.GW6, ""))
}

func TestParseMarksHotplugMemoryOnlyWhenMemhpDefaultStateIsSet(t *testing.T) {
	for _, tc := range []struct {
		name string
		line string
		want bool
	}{
		{name: "absent", line: "imp.hostname=a", want: false},
		{name: "online_movable", line: "imp.hostname=a memhp_default_state=online_movable", want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, Parse(tc.line).HotplugMemory, tc.want)
		})
	}
}
