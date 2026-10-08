import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { waitFor } from '@imp/test-utils/wait-for';
import { $ } from 'bun';
import { buildStubTar } from './test-utils/build-stub-tar';
import { parseTarEntries } from './test-utils/parse-tar-entries';
import {
  BuildContextError,
  listDockerfileCandidates,
  readBuildContext,
  writeBuildContext,
} from './write-build-context';

// `stack` releases in reverse: a test defers what must end before the dir goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-build-context-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir, stack };
}

test('#readBuildContext returns the Dockerfile at the asked path and its text', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([
    { name: 'app.js', content: 'x' },
    { name: 'docker/web.Dockerfile', content: 'FROM busybox:1.37\n' },
  ]);

  await Bun.write(input, bytes);

  const checked = await readBuildContext(input, 'docker/web.Dockerfile', 1024);

  expect(checked).toStrictEqual({
    dockerfilePath: 'docker/web.Dockerfile',
    dockerfile: 'FROM busybox:1.37\n',
  });
});

test('#readBuildContext falls back to a lowercase dockerfile beside a missing Dockerfile', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([{ name: 'dockerfile', content: 'FROM busybox:1.37\n' }]);

  await Bun.write(input, bytes);

  const checked = await readBuildContext(input, 'Dockerfile', 1024);

  expect(checked).toStrictEqual({
    dockerfilePath: 'dockerfile',
    dockerfile: 'FROM busybox:1.37\n',
  });
});

test('#readBuildContext prefers Dockerfile to the lowercase dockerfile beside it', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([
    { name: 'dockerfile', content: 'FROM evil/lower:1\n' },
    { name: 'Dockerfile', content: 'FROM busybox:1.37\n' },
  ]);

  await Bun.write(input, bytes);

  const checked = await readBuildContext(input, 'Dockerfile', 1024);

  expect(checked).toStrictEqual({
    dockerfilePath: 'Dockerfile',
    dockerfile: 'FROM busybox:1.37\n',
  });
});

test('#readBuildContext falls back to a lowercase dockerfile in a subdirectory', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([{ name: 'sub/dockerfile', content: 'FROM busybox:1.37\n' }]);

  await Bun.write(input, bytes);

  const checked = await readBuildContext(input, 'sub/Dockerfile', 1024);

  expect(checked).toStrictEqual({
    dockerfilePath: 'sub/dockerfile',
    dockerfile: 'FROM busybox:1.37\n',
  });
});

test.each([
  ['Dockerfile', ['Dockerfile', 'dockerfile']],
  ['sub/Dockerfile', ['sub/Dockerfile', 'sub/dockerfile']],
  ['Containerfile', ['Containerfile']],
  ['sub/web.Dockerfile', ['sub/web.Dockerfile']],
])('#listDockerfileCandidates lists %s as %j', (dockerfilePath, expected) => {
  expect(listDockerfileCandidates(dockerfilePath)).toStrictEqual(expected);
});

test('#readBuildContext rejects a context without the named Dockerfile', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([{ name: 'containerfile', content: 'FROM busybox:1.37\n' }]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'Containerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    'there is no Containerfile in the build context',
  );
});

test('#readBuildContext rejects a Dockerfile that is a directory', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([
    { name: 'Dockerfile/', type: 'directory' },
    { name: 'dockerfile', content: 'FROM busybox:1.37\n' },
  ]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    'Dockerfile in the build context is a directory, not a file',
  );
});

test('#readBuildContext rejects a Dockerfile that is a symlink', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([
    { name: 'Dockerfile', type: 'symlink', linkname: 'other' },
    { name: 'other', content: 'FROM busybox:1.37\n' },
  ]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    'Dockerfile in the build context is a symlink, not a file',
  );
});

test('#readBuildContext rejects a Dockerfile larger than the limit', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([{ name: 'Dockerfile', content: 'x'.repeat(2048) }]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    'Dockerfile in the build context is larger than 1024 bytes',
  );
});

test('#readBuildContext rejects two entries at one name', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([
    { name: 'Dockerfile', content: 'FROM busybox:1.37\n' },
    { name: './Dockerfile', content: 'FROM evil/second:1\n' },
  ]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    'the build context has "Dockerfile" twice',
  );
});

test('#readBuildContext rejects an entry under a symlink', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([
    { name: 'sub', type: 'symlink', linkname: 'real' },
    { name: 'real/', type: 'directory' },
    { name: 'sub/Dockerfile', content: 'FROM busybox:1.37\n' },
  ]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'sub/Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    'the build context entry "sub/Dockerfile" is under the symlink "sub"',
  );
});

test('#readBuildContext rejects an entry under a file', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([
    { name: 'Dockerfile', content: 'FROM busybox:1.37\n' },
    { name: 'app', content: 'a file' },
    { name: 'app/x', content: 'under it' },
  ]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    'the build context entry "app/x" is under the file "app"',
  );
});

test.each([
  [
    'a hard link',
    { name: 'copy', type: 'link', linkname: 'Dockerfile' },
    'the build context entry "copy" is a hard link; send the file itself',
  ],
  [
    'a fifo',
    { name: 'pipe', type: 'fifo' },
    'the build context entry "pipe" is a fifo, not a file, directory or symlink',
  ],
  [
    'a character device',
    { name: 'null', type: 'character-device', devmajor: 1, devminor: 3 },
    'the build context entry "null" is a character-device, not a file, directory or symlink',
  ],
  [
    'an absolute name',
    { name: '/etc/passwd', content: 'x' },
    'the build context entry "/etc/passwd" leaves the context',
  ],
  [
    'a name that climbs out',
    { name: 'a/../../escape', content: 'x' },
    'the build context entry "a/../../escape" leaves the context',
  ],
  ['an empty name', { name: '', content: 'x' }, 'the build context has an entry named ""'],
  [
    'a name with a NUL',
    { name: 'a', pax: { path: 'a\u0000b' }, content: 'x' },
    String.raw`the build context has an entry named "a\u0000b"`,
  ],
  [
    'a symlink with no target',
    { name: 'dangling', type: 'symlink', linkname: '' },
    'the build context symlink "dangling" has no target',
  ],
  [
    'a security xattr',
    { name: 'app', content: 'x', pax: { 'SCHILY.xattr.security.capability': 'x' } },
    'the build context entry "app" carries the xattr security.capability',
  ],
  [
    'a trusted xattr',
    { name: 'app', content: 'x', pax: { 'LIBARCHIVE.xattr.trusted.x': 'x' } },
    'the build context entry "app" carries the xattr trusted.x',
  ],
  [
    'an unknown pax record',
    { name: 'app', content: 'x', pax: { 'GNU.sparse.map': '0,1' } },
    'the build context entry "app" carries the pax record GNU.sparse.map',
  ],
] as const)('#readBuildContext rejects %s', async (_case, entry, message) => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([{ name: 'Dockerfile', content: 'FROM busybox:1.37\n' }, entry]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    message,
  );
});

test('#readBuildContext rejects a gzipped tar as not a tar', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([{ name: 'Dockerfile', content: 'FROM busybox:1.37\n' }]);

  await Bun.write(input, gzipSync(bytes));

  expect(readBuildContext(input, 'Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    /^the build context is not a tar: /v,
  );
});

test('#readBuildContext rejects plain text as not a tar', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  await Bun.write(input, 'FROM evil/raw:1\n'.repeat(64));

  expect(readBuildContext(input, 'Dockerfile', 1024)).rejects.toThrowWithMessage(
    BuildContextError,
    /^the build context is not a tar: /v,
  );
});

test('#readBuildContext rejects with the reason of a signal aborted before the read', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const reason = new Error('the client went');

  const bytes = await buildStubTar([{ name: 'Dockerfile', content: 'FROM busybox:1.37\n' }]);

  await Bun.write(input, bytes);

  expect(readBuildContext(input, 'Dockerfile', 1024, AbortSignal.abort(reason))).rejects.toBe(
    reason,
  );
});

test('#writeBuildContext writes the files, directories, symlinks and long names again', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');
  const output = join(ctx.dir, 'out.tar');
  const longName = `${'deep/'.repeat(60)}file.txt`;

  const bytes = await buildStubTar([
    { name: './', type: 'directory' },
    { name: './Dockerfile', content: 'FROM busybox:1.37\n' },
    { name: 'app/', type: 'directory' },
    { name: 'app/main.js', content: 'x' },
    { name: 'app/link', type: 'symlink', linkname: `../${longName}` },
    { name: longName, content: 'long' },
  ]);

  await Bun.write(input, bytes);

  const checked = await readBuildContext(input, 'Dockerfile', 1024);

  await writeBuildContext(input, output, checked, checked.dockerfile, 1024);

  const writtenBytes = await readFile(output);
  const written = await parseTarEntries(writtenBytes);

  expect(checked).toStrictEqual({
    dockerfilePath: 'Dockerfile',
    dockerfile: 'FROM busybox:1.37\n',
  });

  expect(
    written.map((entry) => [
      entry.header.name,
      entry.header.type,
      entry.header.linkname,
      entry.content,
    ]),
  ).toStrictEqual([
    ['Dockerfile', 'file', null, 'FROM busybox:1.37\n'],
    ['app/', 'directory', null, ''],
    ['app/main.js', 'file', null, 'x'],
    ['app/link', 'symlink', `../${longName}`, ''],
    [longName, 'file', null, 'long'],
  ]);
});

test('#writeBuildContext keeps the permission bits and cuts the mtime to whole seconds', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');
  const output = join(ctx.dir, 'out.tar');

  const bytes = await buildStubTar([
    {
      name: 'Dockerfile',
      content: 'FROM busybox:1.37\n',
      mode: 0o4755,
      mtime: new Date(1_700_000_000_500),
    },
  ]);

  await Bun.write(input, bytes);

  const checked = await readBuildContext(input, 'Dockerfile', 1024);

  await writeBuildContext(input, output, checked, checked.dockerfile, 1024);

  const writtenBytes = await readFile(output);
  const written = await parseTarEntries(writtenBytes);

  expect(written.map((entry) => [entry.header.mode, entry.header.mtime])).toStrictEqual([
    [0o4755, new Date(1_700_000_000_000)],
  ]);
});

test('#writeBuildContext puts the given text in place of the Dockerfile the check read', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');
  const output = join(ctx.dir, 'out.tar');

  const bytes = await buildStubTar([
    { name: 'dockerfile', content: 'FROM busybox:1.37\n' },
    { name: 'Dockerfile.txt', content: 'FROM busybox:1.37\n' },
    { name: 'app.txt', content: 'app' },
  ]);

  await Bun.write(input, bytes);

  const checked = await readBuildContext(input, 'Dockerfile', 1024);

  await writeBuildContext(input, output, checked, 'FROM busybox@sha256:aaaa\n', 1024);

  const writtenBytes = await readFile(output);
  const written = await parseTarEntries(writtenBytes);

  expect(checked).toStrictEqual({
    dockerfilePath: 'dockerfile',
    dockerfile: 'FROM busybox:1.37\n',
  });

  expect(written.map((entry) => [entry.header.name, entry.content])).toStrictEqual([
    ['dockerfile', 'FROM busybox@sha256:aaaa\n'],
    ['Dockerfile.txt', 'FROM busybox:1.37\n'],
    ['app.txt', 'app'],
  ]);
});

test('#writeBuildContext drops a user xattr', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');
  const output = join(ctx.dir, 'out.tar');

  const bytes = await buildStubTar([
    { name: 'Dockerfile', content: 'FROM busybox:1.37\n', pax: { 'SCHILY.xattr.user.note': 'x' } },
  ]);

  await Bun.write(input, bytes);

  const checked = await readBuildContext(input, 'Dockerfile', 1024);

  await writeBuildContext(input, output, checked, checked.dockerfile, 1024);

  const writtenBytes = await readFile(output);
  const written = await parseTarEntries(writtenBytes);

  expect(written.map((entry) => [entry.header.name, entry.header.pax])).toStrictEqual([
    ['Dockerfile', null],
  ]);
});

test('#writeBuildContext rejects a context whose Dockerfile differs from the one the check read', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');

  const bytes = await buildStubTar([{ name: 'Dockerfile', content: 'FROM busybox:1.37\n' }]);

  await Bun.write(input, bytes);

  expect(
    writeBuildContext(
      input,
      join(ctx.dir, 'out.tar'),
      { dockerfilePath: 'Dockerfile', dockerfile: 'FROM busybox:1.36\n' },
      'FROM busybox:1.36\n',
      1024,
    ),
  ).rejects.toThrowWithMessage(
    Error,
    'the build context changed between its check and its rewrite',
  );
});

test('#writeBuildContext rejects with the reason of a signal aborted during its read', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');
  const output = join(ctx.dir, 'out.tar');

  const reason = new Error('the client went');
  const controller = new AbortController();

  const bytes = await buildStubTar([{ name: 'Dockerfile', content: 'FROM busybox:1.37\n' }]);

  // a FIFO the test feeds, so the read waits for the rest of the tar
  await $`mkfifo ${input}`;

  const writing = writeBuildContext(
    input,
    output,
    { dockerfilePath: 'Dockerfile', dockerfile: 'FROM busybox:1.37\n' },
    'FROM busybox:1.37\n',
    1024,
    controller.signal,
  );

  // the writer settles before the dir goes, once the feed closes and the
  // signal aborts
  ctx.stack.defer(async () => {
    await Promise.allSettled([writing]);
  });

  const feed = await open(input, 'w');

  ctx.stack.defer(() => feed.close());

  ctx.stack.defer(() => {
    controller.abort();
  });

  // every entry, without the two zero blocks that end the tar
  await feed.write(bytes.subarray(0, -1024));

  await waitFor(async () => {
    const written = await stat(output);

    expect(written.size).toBeGreaterThan(0);
  });

  controller.abort(reason);

  expect(writing).rejects.toBe(reason);
});

test('#writeBuildContext rejects with an error of the text of a reason that is not an error', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');
  const output = join(ctx.dir, 'out.tar');

  const controller = new AbortController();

  const bytes = await buildStubTar([{ name: 'Dockerfile', content: 'FROM busybox:1.37\n' }]);

  // a FIFO the test feeds, so the read waits for the rest of the tar
  await $`mkfifo ${input}`;

  const writing = writeBuildContext(
    input,
    output,
    { dockerfilePath: 'Dockerfile', dockerfile: 'FROM busybox:1.37\n' },
    'FROM busybox:1.37\n',
    1024,
    controller.signal,
  );

  // the writer settles before the dir goes, once the feed closes and the
  // signal aborts
  ctx.stack.defer(async () => {
    await Promise.allSettled([writing]);
  });

  const feed = await open(input, 'w');

  ctx.stack.defer(() => feed.close());

  ctx.stack.defer(() => {
    controller.abort();
  });

  // every entry, without the two zero blocks that end the tar
  await feed.write(bytes.subarray(0, -1024));

  await waitFor(async () => {
    const written = await stat(output);

    expect(written.size).toBeGreaterThan(0);
  });

  controller.abort('the client went');

  expect(writing).rejects.toThrowWithMessage(Error, 'the client went');
});

test('#writeBuildContext rejects with the write failure as it is', async () => {
  const ctx = await setupTest();

  const input = join(ctx.dir, 'in.tar');
  const output = join(ctx.dir, 'out.tar');

  const bytes = await buildStubTar([
    { name: 'Dockerfile', content: 'FROM busybox:1.37\n' },
    { name: 'big', content: 'x'.repeat(200_000) },
  ]);

  await Bun.write(input, bytes);

  // a child whose file size limit (16 KiB) fails the rewrite's write with EFBIG
  const child = Bun.spawn(
    [
      'bash',
      '-c',
      'trap "" XFSZ; ulimit -f 16; exec "$@"',
      'bash',
      process.execPath,
      '-e',
      `const { writeBuildContext } = await import(${JSON.stringify(join(import.meta.dir, 'write-build-context.ts'))});
      const failure = await writeBuildContext(${JSON.stringify(input)}, ${JSON.stringify(output)}, { dockerfilePath: 'Dockerfile', dockerfile: 'FROM busybox:1.37\\n' }, 'FROM busybox:1.37\\n', 1024).then(() => null, (error) => error);
      console.log(JSON.stringify({ name: failure?.name, code: failure?.code }));`,
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  ctx.stack.defer(async () => {
    child.kill();

    await child.exited;
  });

  const printed = await new Response(child.stdout).text();

  expect(JSON.parse(printed)).toStrictEqual({ name: 'Error', code: 'EFBIG' });
});
