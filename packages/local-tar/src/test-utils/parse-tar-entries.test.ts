import { expect, test } from 'bun:test';
import tar from 'tar-stream';
import { parseTarEntries } from './parse-tar-entries';

test('it parses each entry in order with its full header and decoded data', async () => {
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

  const entries = await parseTarEntries(new Uint8Array(Bun.concatArrayBuffers(chunks)));

  expect(entries).toStrictEqual([
    {
      header: {
        name: 'ünï',
        mode: 0o644,
        uid: 0,
        gid: 0,
        size: 8,
        mtime: new Date(1_700_000_000_000),
        type: 'file',
        linkname: null,
        uname: '',
        gname: '',
        devmajor: 0,
        devminor: 0,
        pax: { path: 'ünï' },
        byteOffset: 1536,
      },
      content: 'données',
    },
    {
      header: {
        name: 'link',
        mode: 0o644,
        uid: 0,
        gid: 0,
        size: 0,
        mtime: new Date(1_700_000_000_000),
        type: 'symlink',
        linkname: 'ünï',
        uname: '',
        gname: '',
        devmajor: 0,
        devminor: 0,
        pax: null,
        byteOffset: 2560,
      },
      content: '',
    },
  ]);
});

test('it rejects bytes that are not a tar', () => {
  const bytes = new TextEncoder().encode('not a tar\n'.repeat(64));

  expect(parseTarEntries(bytes)).rejects.toThrowWithMessage(
    Error,
    'Invalid tar header. Maybe the tar is corrupted or it needs to be gunzipped?',
  );
});
