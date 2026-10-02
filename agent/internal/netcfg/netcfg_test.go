package netcfg

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseAddr(t *testing.T) {
	tests := []struct {
		cidr    string
		want    string
		wantErr bool
	}{
		{cidr: "10.66.0.2/30", want: "10.66.0.2/30"},
		{cidr: "fd12:3456:789a::a42:2/128", want: "fd12:3456:789a::a42:2/128"},
		{cidr: "10.66.0.2", wantErr: true},
		{cidr: "10.66.0.300/30", wantErr: true},
		{cidr: "not-an-ip", wantErr: true},
	}
	for _, tt := range tests {
		addr, err := parseAddr(tt.cidr)
		if tt.wantErr {
			if err == nil {
				t.Errorf("parseAddr(%q) = %v, want an error", tt.cidr, addr)
			}
			continue
		}
		if err != nil || addr.IPNet.String() != tt.want {
			t.Errorf("parseAddr(%q) = %v, %v; want %s", tt.cidr, addr, err, tt.want)
		}
	}
}

func TestParseGateway(t *testing.T) {
	tests := []struct {
		gw      string
		want    string
		wantErr bool
	}{
		{gw: "10.66.0.1", want: "10.66.0.1"},
		{gw: "fe80::1", want: "fe80::1"},
		{gw: "", want: "<nil>"},
		{gw: "10.66.0.1/30", wantErr: true},
		{gw: "gateway", wantErr: true},
	}
	for _, tt := range tests {
		ip, err := parseGateway(tt.gw)
		if tt.wantErr {
			if err == nil {
				t.Errorf("parseGateway(%q) = %v, want an error", tt.gw, ip)
			}
			continue
		}
		if err != nil || ip.String() != tt.want {
			t.Errorf("parseGateway(%q) = %v, %v; want %s", tt.gw, ip, err, tt.want)
		}
	}
}

func TestWriteResolvConf(t *testing.T) {
	tests := []struct {
		name    string
		servers []string
		symlink bool
		want    string
	}{
		{name: "two servers", servers: []string{"1.1.1.1", "8.8.8.8"},
			want: "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"},
		{name: "no servers keeps the image's file", want: "nameserver 9.9.9.9\n"},
		{name: "a symlink into systemd-resolved is replaced", servers: []string{"1.1.1.1"},
			symlink: true, want: "nameserver 1.1.1.1\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "resolv.conf")
			target := filepath.Join(dir, "stub-resolv.conf")
			if err := os.WriteFile(target, []byte("nameserver 9.9.9.9\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			// the image's file: a plain one, or a link to the stub
			place := os.Rename
			if tt.symlink {
				place = os.Symlink
			}
			if err := place(target, path); err != nil {
				t.Fatal(err)
			}
			if err := writeResolvConf(path, tt.servers); err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(path)
			if err != nil || string(b) != tt.want {
				t.Fatalf("resolv.conf = %q, %v; want %q", b, err, tt.want)
			}
			if fi, _ := os.Lstat(path); tt.symlink && fi.Mode()&os.ModeSymlink != 0 {
				t.Fatal("resolv.conf is still a symlink")
			}
			if tt.symlink {
				if b, _ := os.ReadFile(target); string(b) != "nameserver 9.9.9.9\n" {
					t.Fatalf("the symlink target changed: %q", b)
				}
			}
		})
	}
}

func TestWriteIPv6Conf(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "eth0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeIPv6Conf(root, "eth0", map[string]string{"accept_ra": "0"}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "eth0", "accept_ra"))
	if err != nil || string(got) != "0\n" {
		t.Errorf("accept_ra = %q, %v; want 0", got, err)
	}
	if err := writeIPv6Conf(root, "nope", map[string]string{"accept_ra": "0"}); err == nil {
		t.Error("a missing interface wrote without an error")
	}
}

func TestUp6WithoutAnAddressDoesNothing(t *testing.T) {
	if err := Up6("no-such-link", "", ""); err != nil {
		t.Errorf("Up6 with no address: %v", err)
	}
}
