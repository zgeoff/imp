import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubNft } from '../test-utils/build-stub-nft';
import { createNftRunner, createNftWriter, formatNftError } from './egress-firewall';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'egress-firewall-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  return { dir, [Symbol.asyncDispose]: () => owned.disposeAsync() };
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

  expect({ results, scripts: nft.scripts }).toStrictEqual({
    results: [
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: new Error('nft exited 1: syntax error') },
    ],
    scripts: ['a\n', 'b\n'],
  });
});

test('#createNftRunner hands the script to nft -f - on its stdin', async () => {
  await using ctx = await setupTest();

  const nftBin = join(ctx.dir, 'nft');

  await writeFile(nftBin, `#!/bin/sh\necho "$@" > ${ctx.dir}/argv\ncat > ${ctx.dir}/stdin\n`);
  await chmod(nftBin, 0o755);
  await createNftRunner(nftBin)('table inet imp_egress {}\n');

  const seen = {
    argv: await readFile(join(ctx.dir, 'argv'), 'utf8'),
    stdin: await readFile(join(ctx.dir, 'stdin'), 'utf8'),
  };

  expect(seen).toStrictEqual({ argv: '-f -\n', stdin: 'table inet imp_egress {}\n' });
});

test('#createNftRunner rejects with the exit code and the first line nft printed', async () => {
  await using ctx = await setupTest();

  const nftBin = join(ctx.dir, 'nft');

  await writeFile(
    nftBin,
    '#!/bin/sh\ncat > /dev/null\necho "Error: syntax error, unexpected newline" >&2\necho "garbage" >&2\nexit 3\n',
  );

  await chmod(nftBin, 0o755);

  expect(createNftRunner(nftBin)('garbage\n')).rejects.toThrow(
    new Error('nft exited 3: Error: syntax error, unexpected newline'),
  );
});

test('#formatNftError says nft is not installed when its binary is missing', async () => {
  await using ctx = await setupTest();

  const failure = await createNftRunner(join(ctx.dir, 'nft'))('table inet imp_egress {}\n').then(
    () => null,
    (error: unknown) => error,
  );

  expect(formatNftError(failure)).toBe('nft is not installed');
});

test('#formatNftError keeps the message of any other failure', () => {
  expect(formatNftError(new Error('nft exited 1: Operation not permitted'))).toBe(
    'nft exited 1: Operation not permitted',
  );
});
