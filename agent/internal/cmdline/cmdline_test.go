package cmdline

import (
	"reflect"
	"testing"
)

func TestParse(t *testing.T) {
	line := `console=ttyS0 reboot=k root=/dev/vdb ro init=/imp-agent imp.hostname=smoke ` +
		`imp.ip=10.66.0.2/30 imp.gw=10.66.0.1 imp.dns=1.1.1.1,8.8.8.8 imp.id="a b" ` +
		"virtio_mmio.device=4K@0xd0000000:5\n"
	p := Parse(line)
	if p.Hostname != "smoke" || p.IP != "10.66.0.2/30" || p.GW != "10.66.0.1" {
		t.Fatalf("got %+v", p)
	}
	if want := []string{"1.1.1.1", "8.8.8.8"}; !reflect.DeepEqual(p.DNS, want) {
		t.Fatalf("dns = %v, want %v", p.DNS, want)
	}
	if p.Raw["id"] != "a b" {
		t.Fatalf("quoted value = %q", p.Raw["id"])
	}
	if _, ok := p.Raw["device"]; ok {
		t.Fatal("non-imp key leaked into Raw")
	}
}

func TestParseEmpty(t *testing.T) {
	p := Parse("")
	if p.Hostname != "" || p.DNS != nil || len(p.Raw) != 0 {
		t.Fatalf("got %+v", p)
	}
}

func TestParseEmptyDNSEntries(t *testing.T) {
	p := Parse("imp.dns=,1.1.1.1,,")
	if want := []string{"1.1.1.1"}; !reflect.DeepEqual(p.DNS, want) {
		t.Fatalf("dns = %v, want %v", p.DNS, want)
	}
}
