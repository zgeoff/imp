import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CopyProgress } from './copy-progress';
import { countTarBytes, listLocalEntries, writeLocalEntries } from './pack-local-path';

const SILENT: CopyProgress = { setTotal: () => {}, add: () => {}, finish: () => {} };

test('countTarBytes is the length of the tar writeLocalEntries makes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imp-tar-count-'));

  try {
    const top = join(root, 'top');

    mkdirSync(join(top, 'deep/'.repeat(30)), { recursive: true });
    writeFileSync(join(top, 'empty'), '');
    writeFileSync(join(top, 'odd'), 'x'.repeat(513));
    writeFileSync(join(top, 'block'), 'x'.repeat(1024));
    writeFileSync(join(top, 'ünïcode'), 'pax for a utf-8 name');
    writeFileSync(join(top, 'n'.repeat(140)), 'pax for a long name');
    symlinkSync('t'.repeat(150), join(top, 'far'));

    const entries = await listLocalEntries(top);
    const counted = await countTarBytes(entries);

    const written = { bytes: 0 };

    await writeLocalEntries(
      entries,
      (chunk) => {
        written.bytes += chunk.byteLength;

        return Promise.resolve();
      },
      SILENT,
      () => {},
    );

    expect(counted).toBe(written.bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
