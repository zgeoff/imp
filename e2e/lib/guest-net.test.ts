import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildListenCheck, parseEstabResets } from './guest-net';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'guest-net-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#buildListenCheck passes when the port listens over IPv4', async () => {
  const ctx = await setupTest();

  await writeFile(
    join(ctx.dir, 'tcp'),
    [
      '  sl  local_address rem_address   st',
      '   0: 00000000:1B58 00000000:0000 0A 00000000:00000000',
      '',
    ].join('\n'),
  );

  await writeFile(join(ctx.dir, 'tcp6'), '  sl  local_address rem_address   st\n');

  // the check, run by sh over the stand-in files
  const script = buildListenCheck(7000).replaceAll('/proc/net/', `${ctx.dir}/`);

  const code = await Bun.spawn(['sh', '-c', script]).exited;

  expect(code).toBe(0);
});

test('#buildListenCheck passes when the port listens over IPv6', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dir, 'tcp'), '  sl  local_address rem_address   st\n');

  await writeFile(
    join(ctx.dir, 'tcp6'),
    [
      '  sl  local_address rem_address   st',
      '   0: 00000000000000000000000000000000:0035 00000000000000000000000000000000:0000 0A 0',
      '',
    ].join('\n'),
  );

  // the check, run by sh over the stand-in files
  const script = buildListenCheck(53).replaceAll('/proc/net/', `${ctx.dir}/`);

  const code = await Bun.spawn(['sh', '-c', script]).exited;

  expect(code).toBe(0);
});

test('#buildListenCheck fails for a port that is only connected, not listening', async () => {
  const ctx = await setupTest();

  await writeFile(
    join(ctx.dir, 'tcp'),
    [
      '  sl  local_address rem_address   st',
      '   0: 0A420002:1B58 0A420003:9C40 01 00000000:00000000',
      '',
    ].join('\n'),
  );

  await writeFile(join(ctx.dir, 'tcp6'), '  sl  local_address rem_address   st\n');

  // the check, run by sh over the stand-in files
  const script = buildListenCheck(7000).replaceAll('/proc/net/', `${ctx.dir}/`);

  const code = await Bun.spawn(['sh', '-c', script]).exited;

  expect(code).toBe(1);
});

test('#parseEstabResets reads the EstabResets column of the Tcp lines', () => {
  const snmp = [
    'Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab',
    'Tcp: 1 200 120000 -1 12 3 0 4 1',
  ].join('\n');

  expect(parseEstabResets(snmp)).toBe(4);
});

test('#parseEstabResets rejects lines without the column', () => {
  expect(() => parseEstabResets('Tcp: RtoAlgorithm\nTcp: 1')).toThrowWithMessage(
    Error,
    'no EstabResets in "Tcp: RtoAlgorithm"',
  );
});
