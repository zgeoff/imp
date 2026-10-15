import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { createStubTailscale } from '../../scripts/test-utils/create-stub-tailscale';

// Each test runs tailscale-up.sh with its output in files, so a wait it
// leaves in the background holds no pipe open.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-tailscale-up-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const resolvConf = join(dir, 'resolv.conf');

  // the script reads it at every start; Docker's embedded DNS needs no change
  writeFileSync(resolvConf, 'nameserver 127.0.0.11\n');

  return {
    dir,
    resolvConf,
    tailscale: createStubTailscale(dir),
    out: join(dir, 'out'),
    err: join(dir, 'err'),
  };
}

test('it joins again with the key when the saved node holds other tags than it asks for', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');

  // tailscaled runs already, and the script's waits pass at once
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
        TAILSCALE_AUTHKEY: 'fake-key',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(ctx.tailscale.readCalls('up')).toHaveLength(1);
  expect(ctx.tailscale.readCalls('up')[0]).toContain('--force-reauth');
  expect(ctx.tailscale.readNode().Self.Tags).toStrictEqual(['tag:imp-e2e']);
});

test('it keeps the saved node when it holds the tags it asks for, in any order', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:b', 'tag:a'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
        TAILSCALE_AUTHKEY: 'fake-key',
        IMP_TAILSCALE_TAGS: 'tag:a,tag:b',
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(ctx.tailscale.readCalls('up')).toStrictEqual([]);
});

test('it keeps a saved tag:imp node with the key when no tags are asked for', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
        TAILSCALE_AUTHKEY: 'fake-key',
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(ctx.tailscale.readCalls('up')).toStrictEqual([]);
});

test('it takes the saved node down and fails without a key when it holds other tags', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  expect(result.exitCode).toBe(1);

  expect(readFileSync(ctx.err, 'utf8')).toBe(
    'tailscale-up: the node holds tag:imp, not tag:imp-e2e; give an auth key to join again\n',
  );

  expect(ctx.tailscale.readCalls('up')).toStrictEqual([]);
  expect(ctx.tailscale.readNode().BackendState).toBe('Stopped');
});

test('it fails without a key when the saved node needs a login', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'NeedsLogin',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
      },
    },
  );

  expect(result.exitCode).toBe(1);

  expect(readFileSync(ctx.err, 'utf8')).toBe(
    'tailscale-up: the saved node state is NeedsLogin, not Running; give an auth key to join again\n',
  );

  expect(ctx.tailscale.readCalls('up')).toStrictEqual([]);
});

test('it fails with the log tail when tailscaled does not open its socket', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');

  // no tailscaled runs yet; the one the script starts logs and exits without
  // a socket, and the script's waits for the socket last until it has logged
  createStubBin(ctx.dir, 'ps');
  createStubBin(ctx.dir, 'tailscaled', "echo 'tailscaled: no tun device'");

  createStubBin(
    ctx.dir,
    'sleep',
    `[ -s '${join(ctx.dir, 'state', 'tailscaled.log')}' ] || /bin/sleep "$@"`,
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_SOCKET: join(ctx.dir, 'run', 'tailscaled.sock'),
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
      },
    },
  );

  expect(result.exitCode).toBe(1);

  expect(readFileSync(ctx.err, 'utf8')).toBe(
    'tailscale-up: tailscaled did not start; log tail:\ntailscaled: no tun device\n',
  );
});

test('it takes a node in memory down without a key or state when it holds other tags', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: 'mem',
        IMP_TAILSCALE_HOSTNAME: 'imp',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  expect(result.exitCode).toBe(1);

  expect(readFileSync(ctx.err, 'utf8')).toBe(
    'tailscale-up: the node holds tag:imp, not tag:imp-e2e; give an auth key to join again\n',
  );

  expect(ctx.tailscale.readNode().BackendState).toBe('Stopped');
});

test('it takes a node in memory down without a key or state while it is not Running yet', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  ctx.tailscale.holdStart();

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: 'mem',
        IMP_TAILSCALE_HOSTNAME: 'imp',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  expect(result.exitCode).toBe(1);

  expect(readFileSync(ctx.err, 'utf8')).toBe(
    'tailscale-up: the node in memory is not Running, so its tags are unchecked; taking it down\n',
  );

  expect(ctx.tailscale.readCalls('down')).toHaveLength(1);
});

test('it takes the node down when it is not Running after it joins, when it asks for tags', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });

  ctx.tailscale.holdStart();

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: 'mem',
        IMP_TAILSCALE_HOSTNAME: 'imp',
        TAILSCALE_AUTHKEY: 'fake-key',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  expect(result.exitCode).toBe(1);

  expect(readFileSync(ctx.err, 'utf8')).toBe(
    'tailscale-up: backend state Starting, not Running; taking it down, since its tags are unchecked\n',
  );

  expect(ctx.tailscale.readCalls('up')).toHaveLength(1);
  expect(ctx.tailscale.readCalls('down')).toHaveLength(1);
});

test('it fails and leaves the node up when it is not Running after it joins, when it asks for no tags', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });

  ctx.tailscale.holdStart();

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: 'mem',
        IMP_TAILSCALE_HOSTNAME: 'imp',
        TAILSCALE_AUTHKEY: 'fake-key',
      },
    },
  );

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.err, 'utf8')).toBe('tailscale-up: backend state Starting, not Running\n');
  expect(ctx.tailscale.readCalls('up')).toHaveLength(1);
  expect(ctx.tailscale.readCalls('down')).toStrictEqual([]);
});

test('it exits 0 and waits in the background while the saved node is still Starting', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  ctx.tailscale.holdStart();

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
      },
    },
  );

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.out, 'utf8')).toBe(
    'tailscale-up: the saved node is still Starting after 15 s; going on, and waiting for it in the background\n',
  );
});

test('it joins again with the key once a slow saved node is Running with other tags', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  ctx.tailscale.holdStart();

  Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
        TAILSCALE_AUTHKEY: 'fake-key',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  ctx.tailscale.releaseStart();

  const up = await waitFor(
    () => {
      const [call] = ctx.tailscale.readCalls('up');

      if (call === undefined) {
        throw new Error('no tailscale up yet');
      }

      return call;
    },
    { timeoutMs: 20_000 },
  );

  expect(up).toContain('--force-reauth');

  await waitFor(() => {
    expect(ctx.tailscale.readNode().Self.Tags).toStrictEqual(['tag:imp-e2e']);
  });
}, 30_000);

test('it takes a slow saved node down without a key once it is Running with other tags', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  ctx.tailscale.holdStart();

  Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  ctx.tailscale.releaseStart();

  await waitFor(
    () => {
      expect(ctx.tailscale.readNode().BackendState).toBe('Stopped');
    },
    { timeoutMs: 20_000 },
  );

  expect(readFileSync(ctx.err, 'utf8')).toBe(
    'tailscale-up: the node holds tag:imp, not tag:imp-e2e; give an auth key to join again\n',
  );

  expect(ctx.tailscale.readCalls('up')).toStrictEqual([]);
}, 30_000);

test('it gives up in the background without a key once a slow saved node needs a login', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'NeedsLogin',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  ctx.tailscale.holdStart();

  Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
      },
    },
  );

  ctx.tailscale.releaseStart();

  await waitFor(
    () => {
      expect(readFileSync(ctx.err, 'utf8')).toBe(
        'tailscale-up: the saved node is NeedsLogin; give an auth key to join again\n',
      );
    },
    { timeoutMs: 20_000 },
  );

  expect(ctx.tailscale.readCalls('up')).toStrictEqual([]);
}, 30_000);

test('it takes a saved node down that is still not Running after the wait, when it asks for tags', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  ctx.tailscale.holdStart();

  Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
        TAILSCALE_AUTHKEY: 'fake-key',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  await waitFor(
    () => {
      expect(ctx.tailscale.readCalls('down')).toHaveLength(1);
    },
    { timeoutMs: 20_000 },
  );

  expect(readFileSync(ctx.err, 'utf8')).toBe(
    'tailscale-up: the saved node is still Starting after 30 min; taking it down, since its tags are unchecked\n',
  );
}, 30_000);

test('it never puts the key on the command line', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'state'));
  writeFileSync(join(ctx.dir, 'state', 'tailscaled.state'), 'saved');
  createStubBin(ctx.dir, 'ps', 'echo S');
  createStubBin(ctx.dir, 'sleep');

  ctx.tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  Bun.spawnSync(
    [
      'bash',
      '-c',
      '"$0" >"$1" 2>"$2"',
      new URL('tailscale-up.sh', import.meta.url).pathname,
      ctx.out,
      ctx.err,
    ],
    {
      env: {
        PATH: `${ctx.tailscale.bin}:${process.env['PATH'] ?? ''}`,
        IMP_RESOLV_CONF: ctx.resolvConf,
        IMP_TAILSCALE_STATE_DIR: join(ctx.dir, 'state'),
        IMP_TAILSCALE_HOSTNAME: 'imp',
        TAILSCALE_AUTHKEY: 'fake-key',
        IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      },
    },
  );

  expect(ctx.tailscale.readCalls('up').join('\n')).not.toContain('fake-key');
});
