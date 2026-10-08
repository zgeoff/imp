import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubNft } from '../test-utils/build-stub-nft';
import { createStubNftBin } from '../test-utils/create-stub-nft-bin';
import { createNftRunner, createNftWriter, formatNftError } from './egress-firewall';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'egress-firewall-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#createNftWriter runs the scripts that wait while one runs as one script, in order', async () => {
  const nft = buildStubNft();
  const held = nft.hold((script) => script === 'a\n');
  const write = createNftWriter(nft.runNft);
  const writes = [write('a\n'), write('b\n'), write('c\n')];

  await held.reached;

  held.release();

  await Promise.all(writes);

  expect(nft.scripts).toStrictEqual(['a\n', 'b\nc\n']);
});

test('#createNftWriter runs a refused batch again one script at a time, so only the bad one fails', async () => {
  const nft = buildStubNft();
  const held = nft.hold((script) => script === 'a\n');
  const write = createNftWriter(nft.runNft);

  nft.refuse({ reason: 'syntax error', match: (script) => script.includes('bad') });

  const writes = Promise.allSettled([write('a\n'), write('b\n'), write('bad\n')]);

  await held.reached;

  held.release();

  const results = await writes;

  expect(results).toStrictEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
    { status: 'rejected', reason: new Error('nft exited 1: syntax error') },
  ]);

  expect(nft.scripts).toStrictEqual(['a\n', 'b\n']);
});

test('#createNftRunner runs nft with -f -', async () => {
  const ctx = await setupTest();
  const nft = await createStubNftBin(ctx.dir);

  await createNftRunner(nft.path)('table inet imp_egress {}\n');

  const argv = await nft.readArgv();

  expect(argv).toBe('-f -\n');
});

test('#createNftRunner hands nft the script on its stdin', async () => {
  const ctx = await setupTest();
  const nft = await createStubNftBin(ctx.dir);

  await createNftRunner(nft.path)('table inet imp_egress {}\n');

  const stdin = await nft.readStdin();

  expect(stdin).toBe('table inet imp_egress {}\n');
});

test('#createNftRunner rejects with the exit code and the first line nft printed', async () => {
  const ctx = await setupTest();

  const nft = await createStubNftBin(ctx.dir, {
    stderr: 'Error: syntax error, unexpected newline\ngarbage\n',
    exitCode: 3,
  });

  expect(createNftRunner(nft.path)('garbage\n')).rejects.toThrow(
    new Error('nft exited 3: Error: syntax error, unexpected newline'),
  );
});

test('#createNftRunner rejects with ENOENT when the nft binary is missing', async () => {
  const ctx = await setupTest();

  expect(createNftRunner(join(ctx.dir, 'nft'))('table inet imp_egress {}\n')).rejects.toThrow(
    /^ENOENT: no such file or directory, posix_spawn /v,
  );
});

test('#formatNftError says nft is not installed for a binary that could not start', () => {
  expect(formatNftError(new Error("ENOENT: no such file or directory, posix_spawn 'nft'"))).toBe(
    'nft is not installed',
  );
});

test('#formatNftError keeps the message of any other failure', () => {
  expect(formatNftError(new Error('nft exited 1: Operation not permitted'))).toBe(
    'nft exited 1: Operation not permitted',
  );
});
