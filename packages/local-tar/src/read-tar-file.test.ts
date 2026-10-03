import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tar from 'tar-stream';
import { readTarFile } from './read-tar-file';

// a tar file of these entries (name → content; a trailing / is a directory)
async function writeTar(files: Readonly<Record<string, string>>) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-read-tar-'));
  const path = join(dir, 'context.tar');
  const pack = tar.pack();

  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) {
      pack.entry({ name, type: 'directory' });
    } else {
      pack.entry({ name }, content);
    }
  }

  pack.finalize();

  const chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  writeFileSync(path, Bun.concatArrayBuffers(chunks, Infinity, true));

  return {
    path,
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('it reads a file by its name in the context, with or without ./', async () => {
  using archive = await writeTar({
    './': '',
    './app.js': 'x',
    './sub/': '',
    './sub/Dockerfile': 'FROM busybox\n',
  });

  const plain = await readTarFile(archive.path, 'sub/Dockerfile', 1024);
  const dotted = await readTarFile(archive.path, './sub//Dockerfile', 1024);

  expect(plain).toBe('FROM busybox\n');
  expect(dotted).toBe('FROM busybox\n');
});

test('a missing file is null, a directory is not a file, and a large one is an error', async () => {
  using archive = await writeTar({ 'sub/': '', Dockerfile: 'x'.repeat(100) });

  const missing = await readTarFile(archive.path, 'Containerfile', 1024);
  const directory = await readTarFile(archive.path, 'sub', 1024);
  const large = await readTarFile(archive.path, 'Dockerfile', 10).catch((error: unknown) => error);

  expect(missing).toBeNull();
  expect(directory).toBeNull();
  expect(String(large)).toContain('larger than 10 bytes');
});
