package server

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"gotest.tools/v3/assert"
)

func TestCountEstablishedCountsExternalEstablishedSockets(t *testing.T) {
	for _, tc := range []struct {
		name  string
		table string
	}{
		// one loopback (skipped), one external, one LISTEN
		{name: "tcp", table: `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 1 1 0 20 4 30 10 -1
   1: 0200420A:C350 01010101:01BB 01 00000000:00000000 00:00000000 00000000     0        0 2 1 0 20 4 30 10 -1
   2: 0200420A:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3 1 0 20 4 30 10 -1
`},
		// ::1 and ::ffff:127.0.0.1 skipped, one v4-mapped external
		{name: "tcp6", table: `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000001000000:1F90 00000000000000000000000001000000:C350 01
   1: 0000000000000000FFFF00000200420A:1F90 0000000000000000FFFF000001010101:C350 01
   2: 0000000000000000FFFF00000100007F:1F90 0000000000000000FFFF00000100007F:C350 01
`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc.name)
			assert.NilError(t, os.WriteFile(path, []byte(tc.table), 0o644))

			n, err := countEstablished(path)

			assert.NilError(t, err)
			assert.Equal(t, n, 1)
		})
	}
}

func TestCountEstablishedReportsAMissingTable(t *testing.T) {
	_, err := countEstablished(filepath.Join(t.TempDir(), "tcp"))

	assert.ErrorIs(t, err, fs.ErrNotExist)
}
