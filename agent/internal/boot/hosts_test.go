package boot

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHostsWithName(t *testing.T) {
	const def = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\tnew\n"
	tests := []struct {
		name, in, want string
	}{
		{"empty", "", def},
		{"blank", "\n\n", def},
		{"renamed", "127.0.0.1 localhost\n127.0.1.1\told\n# keep\n", "127.0.0.1 localhost\n127.0.1.1\tnew\n# keep\n"},
		{"aliases dropped", "127.0.1.1 old old.local\n", "127.0.1.1\tnew\n"},
		{"duplicates collapse", "127.0.1.1 a\n10.0.0.1 db\n127.0.1.1 b\n", "127.0.1.1\tnew\n10.0.0.1 db\n"},
		{"appended", "127.0.0.1 localhost", "127.0.0.1 localhost\n127.0.1.1\tnew\n"},
		{"aliases kept", "127.0.1.1 new new.local\n", "127.0.1.1 new new.local\n"},
		{"unchanged", "127.0.0.1 localhost\n127.0.1.1\tnew\n", "127.0.0.1 localhost\n127.0.1.1\tnew\n"},
		// Only a 127.0.1.1 address field counts, not a mention in a comment.
		{"comment", "# 127.0.1.1 old\n", "# 127.0.1.1 old\n127.0.1.1\tnew\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hostsWithName(tt.in, "new"); got != tt.want {
				t.Fatalf("hostsWithName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestUpdateHostsMissingFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hosts")
	if err := updateHosts(p, "imp"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil || string(b) != hostsWithName("", "imp") {
		t.Fatalf("hosts = %q, %v", b, err)
	}
}

func TestUpdateHostsRewritesInPlace(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "hosts")
	if err := os.WriteFile(p, []byte("127.0.1.1 old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := updateHosts(p, "new"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil || string(b) != "127.0.1.1\tnew\n" {
		t.Fatalf("hosts = %q, %v", b, err)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v, want 0644", fi.Mode().Perm())
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Fatalf("temporary file left behind: %v", ents)
	}
}

func TestUpdateHostsFollowsSymlink(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "real-hosts"), filepath.Join(dir, "hosts")
	if err := os.WriteFile(target, []byte("127.0.1.1 old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real-hosts", link); err != nil {
		t.Fatal(err)
	}
	if err := updateHosts(link, "new"); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link was replaced: %v", err)
	}
	if b, err := os.ReadFile(target); err != nil || string(b) != "127.0.1.1\tnew\n" {
		t.Fatalf("target = %q, %v", b, err)
	}
}

func TestUpdateHostsDanglingSymlink(t *testing.T) {
	link := filepath.Join(t.TempDir(), "hosts")
	if err := os.Symlink("missing", link); err != nil {
		t.Fatal(err)
	}
	if err := updateHosts(link, "new"); err == nil {
		t.Fatal("updateHosts replaced a dangling symlink")
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link was replaced: %v", err)
	}
}
