import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import type { Header } from 'tar-stream';
import {
  BuildContextError,
  listDockerfileCandidates,
  readBuildContext,
  writeBuildContext,
} from './write-build-context';

type Entry = Partial<Header> & {
  readonly name: string;
  readonly content?: string;
};

const DOCKERFILE = 'FROM busybox:1.37\n';
const LONG_NAME = `${'deep/'.repeat(60)}file.txt`;

async function writeTarBytes(entries: readonly Entry[]): Promise<Uint8Array> {
  const pack = tar.pack();

  for (const { content, ...header } of entries) {
    pack.entry({ mtime: new Date(1_700_000_000_500), ...header }, content ?? '');
  }

  pack.finalize();

  const chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  return new Uint8Array(Bun.concatArrayBuffers(chunks));
}

// a context of these bytes, checked and written again with its Dockerfile
// as replacement gives it; the result or what was thrown
async function runRewrite(
  bytes: Uint8Array,
  dockerfile = 'Dockerfile',
  replacement?: (text: string) => string,
) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-rewrite-context-'));
  const input = join(dir, 'in.tar');
  const output = join(dir, 'out.tar');

  writeFileSync(input, bytes);

  try {
    const result = await readBuildContext(input, dockerfile, 1024)
      .then(async (checked) => {
        const text =
          replacement === undefined ? checked.dockerfile : replacement(checked.dockerfile);

        await writeBuildContext(input, output, checked, text, 1024);

        return checked;
      })
      .catch((error: unknown) => error);

    return {
      result,
      written: result instanceof Error ? null : readFileSync(output),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runEntriesRewrite(entries: readonly Entry[], dockerfile = 'Dockerfile') {
  const bytes = await writeTarBytes(entries);

  return runRewrite(bytes, dockerfile);
}

async function readRefusal(entries: readonly Entry[], dockerfile = 'Dockerfile'): Promise<string> {
  const outcome = await runEntriesRewrite(entries, dockerfile);

  expect(outcome.result).toBeInstanceOf(BuildContextError);

  return outcome.result instanceof Error ? outcome.result.message : '';
}

async function listHeaders(bytes: Uint8Array): Promise<Header[]> {
  const extract = tar.extract();
  const headers: Header[] = [];

  extract.end(bytes);

  for await (const entry of extract) {
    headers.push(entry.header);
    entry.resume();
  }

  return headers;
}

test('a context is written again with its files, directories, symlinks and long names', async () => {
  const rewritten = await runEntriesRewrite([
    { name: './', type: 'directory' },
    { name: './Dockerfile', content: DOCKERFILE, mode: 0o4755 },
    { name: 'app/', type: 'directory' },
    { name: 'app/main.js', content: 'x' },
    { name: 'app/link', type: 'symlink', linkname: `../${LONG_NAME}` },
    { name: LONG_NAME, content: 'long' },
  ]);

  expect(rewritten.result).toEqual({
    dockerfilePath: 'Dockerfile',
    dockerfile: DOCKERFILE,
  });

  const headers = await listHeaders(rewritten.written ?? new Uint8Array());

  expect(headers.map((header) => [header.name, header.type])).toEqual([
    ['Dockerfile', 'file'],
    ['app/', 'directory'],
    ['app/main.js', 'file'],
    ['app/link', 'symlink'],
    [LONG_NAME, 'file'],
  ]);

  expect(headers[0]?.mode).toBe(0o4755);
  expect(headers[0]?.mtime.getTime()).toBe(1_700_000_000_000);
  expect(headers[3]?.linkname).toBe(`../${LONG_NAME}`);
});

test('the Dockerfile falls back to dockerfile beside it, as the frontend reads it', async () => {
  const lower = await runEntriesRewrite([{ name: 'dockerfile', content: DOCKERFILE }]);

  const both = await runEntriesRewrite([
    { name: 'dockerfile', content: 'FROM evil/lower:1\n' },
    { name: 'Dockerfile', content: DOCKERFILE },
  ]);

  const nested = await runEntriesRewrite(
    [{ name: 'sub/dockerfile', content: DOCKERFILE }],
    'sub/Dockerfile',
  );

  expect(lower.result).toEqual({
    dockerfilePath: 'dockerfile',
    dockerfile: DOCKERFILE,
  });

  expect(both.result).toEqual({
    dockerfilePath: 'Dockerfile',
    dockerfile: DOCKERFILE,
  });

  expect(nested.result).toEqual({
    dockerfilePath: 'sub/dockerfile',
    dockerfile: DOCKERFILE,
  });

  expect(listDockerfileCandidates('Containerfile')).toEqual(['Containerfile']);

  const missing = await readRefusal(
    [{ name: 'containerfile', content: DOCKERFILE }],
    'Containerfile',
  );

  expect(missing).toBe('there is no Containerfile in the build context');
});

// the data of each file in the tar, by name
async function readFiles(bytes: Uint8Array): Promise<Map<string, string>> {
  const extract = tar.extract();

  const files = new Map<string, string>();

  extract.end(bytes);

  for await (const entry of extract) {
    const chunks: Uint8Array[] = [];

    for await (const chunk of entry) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      }
    }

    files.set(entry.header.name, new TextDecoder().decode(Bun.concatArrayBuffers(chunks)));
  }

  return files;
}

test('the write puts the given text in place of the Dockerfile the check read', async () => {
  const pinned = 'FROM busybox@sha256:aaaa\n';

  const bytes = await writeTarBytes([
    { name: 'dockerfile', content: DOCKERFILE },
    { name: 'Dockerfile.txt', content: DOCKERFILE },
    { name: 'app.txt', content: 'app' },
  ]);

  const rewritten = await runRewrite(bytes, 'Dockerfile', () => pinned);

  expect(rewritten.result).toEqual({
    dockerfilePath: 'dockerfile',
    dockerfile: DOCKERFILE,
  });

  const files = await readFiles(rewritten.written ?? new Uint8Array());

  expect(Object.fromEntries(files)).toEqual({
    dockerfile: pinned,
    'Dockerfile.txt': DOCKERFILE,
    'app.txt': 'app',
  });
});

test('a Dockerfile that is not a regular file is refused, not passed over', async () => {
  const directory = await readRefusal([
    { name: 'Dockerfile/', type: 'directory' },
    { name: 'dockerfile', content: DOCKERFILE },
  ]);

  const symlink = await readRefusal([
    { name: 'Dockerfile', type: 'symlink', linkname: 'other' },
    { name: 'other', content: DOCKERFILE },
  ]);

  const large = await readRefusal([{ name: 'Dockerfile', content: 'x'.repeat(2048) }]);

  expect(directory).toBe('Dockerfile in the build context is a directory, not a file');
  expect(symlink).toBe('Dockerfile in the build context is a symlink, not a file');
  expect(large).toBe('Dockerfile in the build context is larger than 1024 bytes');
});

test('two entries at one name, or an entry under a symlink or a file, are refused', async () => {
  const twice = await readRefusal([
    { name: 'Dockerfile', content: DOCKERFILE },
    { name: './Dockerfile', content: 'FROM evil/second:1\n' },
  ]);

  const underSymlink = await readRefusal(
    [
      { name: 'sub', type: 'symlink', linkname: 'real' },
      { name: 'real/', type: 'directory' },
      { name: 'sub/Dockerfile', content: DOCKERFILE },
    ],
    'sub/Dockerfile',
  );

  const underFile = await readRefusal([
    { name: 'Dockerfile', content: DOCKERFILE },
    { name: 'app', content: 'a file' },
    { name: 'app/x', content: 'under it' },
  ]);

  expect(twice).toBe('the build context has "Dockerfile" twice');
  expect(underSymlink).toBe('the build context entry "sub/Dockerfile" is under the symlink "sub"');
  expect(underFile).toBe('the build context entry "app/x" is under the file "app"');
});

test('hard links, special files and names outside the context are refused', async () => {
  const base = { name: 'Dockerfile', content: DOCKERFILE };

  const refusals = await Promise.all([
    readRefusal([base, { name: 'copy', type: 'link', linkname: 'Dockerfile' }]),
    readRefusal([base, { name: 'pipe', type: 'fifo' }]),
    readRefusal([base, { name: 'null', type: 'character-device', devmajor: 1, devminor: 3 }]),
    readRefusal([base, { name: '/etc/passwd', content: 'x' }]),
    readRefusal([base, { name: 'a/../../escape', content: 'x' }]),
  ]);

  expect(refusals).toEqual([
    'the build context entry "copy" is a hard link; send the file itself',
    'the build context entry "pipe" is a fifo, not a file, directory or symlink',
    'the build context entry "null" is a character-device, not a file, directory or symlink',
    'the build context entry "/etc/passwd" leaves the context',
    'the build context entry "a/../../escape" leaves the context',
  ]);
});

test('user xattrs are dropped; security and other xattrs, and unknown pax records, are refused', async () => {
  const rewritten = await runEntriesRewrite([
    {
      name: 'Dockerfile',
      content: DOCKERFILE,
      pax: { 'SCHILY.xattr.user.note': 'x' },
    },
  ]);

  expect(rewritten.result).toEqual({
    dockerfilePath: 'Dockerfile',
    dockerfile: DOCKERFILE,
  });

  const headers = await listHeaders(rewritten.written ?? new Uint8Array());

  expect(headers[0]?.pax).toBeNull();

  const refusals = await Promise.all(
    [
      { 'SCHILY.xattr.security.capability': 'x' },
      { 'LIBARCHIVE.xattr.trusted.x': 'x' },
      { 'GNU.sparse.map': '0,1' },
    ].map((pax) => readRefusal([{ name: 'Dockerfile', content: DOCKERFILE, pax }])),
  );

  expect(refusals).toEqual([
    'the build context entry "Dockerfile" carries the xattr security.capability',
    'the build context entry "Dockerfile" carries the xattr trusted.x',
    'the build context entry "Dockerfile" carries the pax record GNU.sparse.map',
  ]);
});

test('a compressed or broken body is refused as not a tar', async () => {
  const plain = await writeTarBytes([{ name: 'Dockerfile', content: DOCKERFILE }]);
  const gzipped = await runRewrite(gzipSync(plain));
  const text = await runRewrite(new TextEncoder().encode('FROM evil/raw:1\n'.repeat(64)));

  for (const outcome of [gzipped, text]) {
    expect(outcome.result).toBeInstanceOf(BuildContextError);
    expect(String(outcome.result)).toContain('the build context is not a tar');
  }
});

test('an aborted signal stops either pass, before or during its read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-abort-context-'));
  const input = join(dir, 'in.tar');

  const entries = Array.from({ length: 3000 }, (_entry, index) => ({
    name: `f${String(index)}`,
    content: 'x'.repeat(512),
  }));

  const bytes = await writeTarBytes([{ name: 'Dockerfile', content: DOCKERFILE }, ...entries]);

  writeFileSync(input, bytes);

  try {
    const checked = await readBuildContext(input, 'Dockerfile', 1024);

    const before = new AbortController();

    before.abort(new Error('the client went'));

    const early = await readBuildContext(input, 'Dockerfile', 1024, before.signal).catch(
      (error: unknown) => error,
    );

    const during = new AbortController();

    const writing = writeBuildContext(
      input,
      join(dir, 'out.tar'),
      checked,
      DOCKERFILE,
      1024,
      during.signal,
    );

    during.abort(new Error('the client went'));

    const late = await writing.catch((error: unknown) => error);

    expect(early).toMatchObject({ message: 'the client went' });
    expect(late).toMatchObject({ message: 'the client went' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
