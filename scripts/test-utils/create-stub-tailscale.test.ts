import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubTailscale } from './create-stub-tailscale';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-stub-tailscale-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it prints the node it was given as its status', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.dir);

  tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'status',
    '--json',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });
});

test('it fails status before any node is written, as with no tailscaled', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.dir);

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'status',
    '--json',
  ]);

  expect(result.exitCode).toBe(1);
});

test('it reports Starting while held, whatever the node says', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.dir);

  tailscale.writeNode({
    BackendState: 'Running',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });

  tailscale.holdStart();

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'status',
    '--json',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({ BackendState: 'Starting' });
});

test('it reports the node again once the start is released', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.dir);

  tailscale.writeNode({
    BackendState: 'NeedsLogin',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });

  tailscale.holdStart();
  tailscale.releaseStart();

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'status',
    '--json',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    BackendState: 'NeedsLogin',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });
});

test('it saves a Running node with the hostname and tags that up names', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.dir);

  Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'up',
    '--reset',
    '--auth-key=file:/run/key',
    '--hostname=imp-b',
    '--advertise-tags=tag:a,tag:b',
    '--accept-dns=false',
  ]);

  expect(tailscale.readNode()).toStrictEqual({
    BackendState: 'Running',
    Self: {
      HostName: 'imp-b',
      Tags: ['tag:a', 'tag:b'],
      TailscaleIPs: ['100.64.0.9'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });
});

test('it stops the node on down and keeps the rest of it', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.dir);

  tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.ts.net.',
    },
  });

  Bun.spawnSync([join(tailscale.bin, 'tailscale'), '--socket=/run/ts.sock', 'down']);

  expect(tailscale.readNode()).toStrictEqual({
    BackendState: 'Stopped',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.ts.net.',
    },
  });
});

test('it reads back the arguments after the socket of each call with one verb, in order', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.dir);

  Bun.spawnSync([join(tailscale.bin, 'tailscale'), '--socket=/run/ts.sock', 'up', '--hostname=a']);
  Bun.spawnSync([join(tailscale.bin, 'tailscale'), '--socket=/run/ts.sock', 'down']);
  Bun.spawnSync([join(tailscale.bin, 'tailscale'), '--socket=/run/ts.sock', 'up', '--hostname=b']);

  expect(tailscale.readCalls('up')).toStrictEqual(['up --hostname=a', 'up --hostname=b']);
});
