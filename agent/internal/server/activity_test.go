package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCountEstablished(t *testing.T) {
	table := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 1 1 0 20 4 30 10 -1
   1: 0200420A:C350 01010101:01BB 01 00000000:00000000 00:00000000 00000000     0        0 2 1 0 20 4 30 10 -1
   2: 0200420A:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3 1 0 20 4 30 10 -1
`
	table6 := `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000001000000:1F90 00000000000000000000000001000000:C350 01
   1: 0000000000000000FFFF00000200420A:1F90 0000000000000000FFFF000001010101:C350 01
   2: 0000000000000000FFFF00000100007F:1F90 0000000000000000FFFF00000100007F:C350 01
`
	dir := t.TempDir()
	for name, body := range map[string]string{"tcp": table, "tcp6": table6} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// tcp: one loopback (skipped), one external, one LISTEN.
	if n, err := countEstablished(filepath.Join(dir, "tcp")); err != nil || n != 1 {
		t.Fatalf("tcp: n=%d err=%v, want 1", n, err)
	}
	// tcp6: ::1 and ::ffff:127.0.0.1 skipped, one v4-mapped external.
	if n, err := countEstablished(filepath.Join(dir, "tcp6")); err != nil || n != 1 {
		t.Fatalf("tcp6: n=%d err=%v, want 1", n, err)
	}
}
