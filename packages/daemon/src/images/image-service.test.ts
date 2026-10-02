import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config';
import { openDatabase } from '../db/open-database';
import { createXfsBackend } from '../storage/xfs-backend';
import { createImageService } from './image-service';

// These all fail before any docker command runs, so no docker is needed.
test('it refuses refs and build contexts that docker could read as flags', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db,
      storage: createXfsBackend({ dataDir }),
    });

    for (const ref of ['--help', '-v/:/host', 'ubuntu --privileged', '']) {
      const failure = await images.addImage(ref, 'x').catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
      expect(String(failure)).toContain('invalid image reference');
    }

    const buildFailure = await images
      .buildImage('--file=/etc/passwd', 'x')
      .catch((error: unknown) => error);

    expect(buildFailure).toMatchObject({ code: 'BAD_REQUEST' });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('it refuses a build context that is not on the impd host', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db,
      storage: createXfsBackend({ dataDir }),
    });

    const failure = await images
      .buildImage(`${dataDir}/no-such-dir`, 'x')
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(failure)).toContain('does not exist on the impd host');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
