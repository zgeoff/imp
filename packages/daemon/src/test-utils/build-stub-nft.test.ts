import { expect, test } from 'bun:test';
import { buildStubNft } from './build-stub-nft';

test('it records each script it takes, in order', async () => {
  const nft = buildStubNft();

  await nft.runNft('add element inet imp_egress allow0 { 192.0.2.1 }\n');
  await nft.runNft('delete element inet imp_egress allow0 { 192.0.2.1 }\n');

  expect(nft.scripts).toStrictEqual([
    'add element inet imp_egress allow0 { 192.0.2.1 }\n',
    'delete element inet imp_egress allow0 { 192.0.2.1 }\n',
  ]);
});

test('it reads back the last whole table, and no element change', async () => {
  const nft = buildStubNft();

  await nft.runNft('table inet imp_egress {}\ndelete table inet imp_egress\nfirst\n');
  await nft.runNft('table inet imp_egress {}\ndelete table inet imp_egress\nsecond\n');
  await nft.runNft('add element inet imp_egress allow0 { 192.0.2.1 }\n');

  expect(nft.readTable()).toBe('table inet imp_egress {}\ndelete table inet imp_egress\nsecond\n');
});

test('it reads no table before nft has taken one', () => {
  const nft = buildStubNft();

  expect(nft.readTable()).toBeNull();
});

test('it refuses as runNft reports nft exiting 1, and takes nothing of the script', () => {
  const nft = buildStubNft();

  nft.refuse({ reason: 'Error: Could not process rule: No such file or directory' });

  expect(nft.runNft('add element inet imp_egress allow0 { 192.0.2.1 }\n')).rejects.toThrow(
    new Error('nft exited 1: Error: Could not process rule: No such file or directory'),
  );

  expect(nft.scripts).toStrictEqual([]);
});

test('it refuses only the scripts the match picks', async () => {
  const nft = buildStubNft();

  nft.refuse({ reason: 'syntax error', match: (script) => script.includes('bad') });

  const results = await Promise.allSettled([nft.runNft('good\n'), nft.runNft('bad\n')]);

  expect(results.map((result) => result.status)).toStrictEqual(['fulfilled', 'rejected']);
  expect(nft.scripts).toStrictEqual(['good\n']);
});

test('it takes scripts again once its refusals are spent', async () => {
  const nft = buildStubNft();

  nft.refuse({ reason: 'table busy', times: 1 });

  const results = await Promise.allSettled([nft.runNft('first\n'), nft.runNft('second\n')]);

  expect(results.map((result) => result.status)).toStrictEqual(['rejected', 'fulfilled']);
  expect(nft.scripts).toStrictEqual(['second\n']);
});

test('it takes every script again after accept', async () => {
  const nft = buildStubNft();

  nft.refuse({ reason: 'nft is not installed' });
  nft.accept();

  await nft.runNft('table\n');

  expect(nft.scripts).toStrictEqual(['table\n']);
});

test('it holds a matched script until the test releases it', async () => {
  const nft = buildStubNft();
  const held = nft.hold((script) => script.includes('slow'));
  const run = nft.runNft('slow\n');

  const reached = await held.reached;

  const before = [...nft.scripts];

  held.release();

  await run;

  expect({ reached, before, after: nft.scripts }).toStrictEqual({
    reached: 'slow\n',
    before: [],
    after: ['slow\n'],
  });
});
