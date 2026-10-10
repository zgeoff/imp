import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubGhAttestation } from './create-stub-gh-attestation';

function setupTest() {
  const bin = mkdtempSync(join(tmpdir(), 'stub-gh-'));

  onTestFinished(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  return { bin };
}

test('it succeeds auth status and attestation verify when logged in and verifying', () => {
  const ctx = setupTest();

  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const codes = [
    Bun.spawnSync([join(ctx.bin, 'gh'), 'auth', 'status']).exitCode,
    Bun.spawnSync([join(ctx.bin, 'gh'), 'attestation', 'verify', 'imp', '-R', 'zgeoff/imp'])
      .exitCode,
  ];

  expect(codes).toStrictEqual([0, 0]);
});

test('it fails auth status when logged out', () => {
  const ctx = setupTest();

  createStubGhAttestation({ bin: ctx.bin, loggedIn: false, verifies: true });

  expect(Bun.spawnSync([join(ctx.bin, 'gh'), 'auth', 'status']).exitCode).toBe(1);
});

test('it fails attestation verify when it does not verify', () => {
  const ctx = setupTest();

  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: false });

  expect(Bun.spawnSync([join(ctx.bin, 'gh'), 'attestation', 'verify', 'imp']).exitCode).toBe(1);
});

test('it succeeds any other command', () => {
  const ctx = setupTest();

  createStubGhAttestation({ bin: ctx.bin, loggedIn: false, verifies: false });

  expect(Bun.spawnSync([join(ctx.bin, 'gh'), 'release', 'list']).exitCode).toBe(0);
});

test('it records the arguments of each call in order', () => {
  const ctx = setupTest();
  const gh = createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  Bun.spawnSync([join(ctx.bin, 'gh'), 'auth', 'status']);
  Bun.spawnSync([join(ctx.bin, 'gh'), 'attestation', 'verify', 'imp', '-R', 'zgeoff/imp']);

  expect(gh.readCalls()).toStrictEqual(['auth status', 'attestation verify imp -R zgeoff/imp']);
});

test('it records no calls before the first', () => {
  const ctx = setupTest();
  const gh = createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  expect(gh.readCalls()).toStrictEqual([]);
});
