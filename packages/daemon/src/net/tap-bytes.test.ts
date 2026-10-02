import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuestNetBytes } from './tap-bytes';

test('what the host receives on the tap is what the guest sent', () => {
  const sys = mkdtempSync(join(tmpdir(), 'imp-sys-'));

  try {
    const statistics = join(sys, 'class', 'net', 'imp3', 'statistics');

    mkdirSync(statistics, { recursive: true });

    // the guest uploaded 5000 bytes and downloaded 70
    writeFileSync(join(statistics, 'rx_bytes'), '5000\n');
    writeFileSync(join(statistics, 'tx_bytes'), '70\n');

    expect(readGuestNetBytes('imp3', sys)).toEqual({ rxBytes: 70, txBytes: 5000 });
    expect(readGuestNetBytes('imp4', sys)).toBeNull();
  } finally {
    rmSync(sys, { recursive: true, force: true });
  }
});
