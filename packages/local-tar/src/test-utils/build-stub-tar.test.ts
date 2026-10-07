import { expect, test } from 'bun:test';
import { buildStubTar } from './build-stub-tar';
import { parseTarEntries } from './parse-tar-entries';

test('it packs each entry in order with its header and content', async () => {
  const bytes = await buildStubTar([
    { name: 'app/', type: 'directory', mtime: new Date(1_700_000_000_000) },
    { name: 'app/main.js', content: 'x', mode: 0o755, mtime: new Date(1_700_000_000_000) },
  ]);

  const entries = await parseTarEntries(bytes);

  expect(entries).toStrictEqual([
    {
      header: {
        name: 'app/',
        mode: 0o755,
        uid: 0,
        gid: 0,
        size: 0,
        byteOffset: 512,
        mtime: new Date(1_700_000_000_000),
        type: 'directory',
        linkname: null,
        uname: '',
        gname: '',
        devmajor: 0,
        devminor: 0,
        pax: null,
      },
      content: '',
    },
    {
      header: {
        name: 'app/main.js',
        mode: 0o755,
        uid: 0,
        gid: 0,
        size: 1,
        byteOffset: 1024,
        mtime: new Date(1_700_000_000_000),
        type: 'file',
        linkname: null,
        uname: '',
        gname: '',
        devmajor: 0,
        devminor: 0,
        pax: null,
      },
      content: 'x',
    },
  ]);
});

test('it ends the tar with two zero blocks', async () => {
  const bytes = await buildStubTar([{ name: 'a', content: 'x' }]);

  expect(bytes.subarray(-1024)).toStrictEqual(new Uint8Array(1024));
});
