import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFirecrackerClient } from './firecracker-client';

test('a call to a Firecracker that never answers fails after its timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));
  const socket = join(dir, 'api.sock');

  // accepts every request and never answers, like a wedged VMM
  const server = Bun.serve({
    unix: socket,
    fetch: () => new Promise<Response>(() => {}),
  });

  try {
    const client = createFirecrackerClient(socket, { requestMs: 50, snapshotMs: 100 });

    const paused = await client.pause().catch((error: unknown) => error);

    const snapshot = await client
      .createSnapshot({ snapshotPath: 'a', memFilePath: 'b' })
      .catch((error: unknown) => error);

    expect(paused).toMatchObject({ message: 'firecracker PATCH /vm: no answer within 50 ms' });

    expect(snapshot).toMatchObject({
      message: 'firecracker PUT /snapshot/create: no answer within 100 ms',
    });
  } finally {
    await server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  }
});
