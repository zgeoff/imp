import { expect, test } from 'bun:test';
import tar from 'tar-stream';
import { readTarEntries } from './read-tar-entries';

test('it reads each entry in order with its header and decoded data', async () => {
  const pack = tar.pack();

  pack.entry({ name: 'ünï', mtime: new Date(1_700_000_000_000) }, 'données');

  pack.entry({
    name: 'link',
    type: 'symlink',
    linkname: 'ünï',
    mtime: new Date(1_700_000_000_000),
  });

  pack.finalize();

  const chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  const entries = await readTarEntries(new Uint8Array(Bun.concatArrayBuffers(chunks)));

  expect(
    entries.map((entry) => [
      entry.header.name,
      entry.header.type,
      entry.header.size,
      entry.header.linkname,
      entry.content,
    ]),
  ).toStrictEqual([
    ['ünï', 'file', 8, null, 'données'],
    ['link', 'symlink', 0, 'ünï', ''],
  ]);
});

test('it rejects bytes that are not a tar', () => {
  const bytes = new TextEncoder().encode('not a tar\n'.repeat(64));

  expect(readTarEntries(bytes)).rejects.toThrowWithMessage(
    Error,
    'Invalid tar header. Maybe the tar is corrupted or it needs to be gunzipped?',
  );
});
