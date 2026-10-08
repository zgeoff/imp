import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubGhAttestation } from './create-stub-gh-attestation';

function setupTest() {
  using stack = new DisposableStack();

  const bin = mkdtempSync(join(tmpdir(), 'stub-gh-'));

  stack.defer(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    bin,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it succeeds auth status and attestation verify when logged in and verifying', () => {
  using ctx = setupTest();

  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const codes = [
    Bun.spawnSync([join(ctx.bin, 'gh'), 'auth', 'status']).exitCode,
    Bun.spawnSync([join(ctx.bin, 'gh'), 'attestation', 'verify', 'imp', '-R', 'zgeoff/imp'])
      .exitCode,
  ];

  expect(codes).toStrictEqual([0, 0]);
});

test('it fails auth status when logged out', () => {
  using ctx = setupTest();

  createStubGhAttestation({ bin: ctx.bin, loggedIn: false, verifies: true });

  expect(Bun.spawnSync([join(ctx.bin, 'gh'), 'auth', 'status']).exitCode).toBe(1);
});

test('it fails attestation verify when it does not verify', () => {
  using ctx = setupTest();

  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: false });

  expect(Bun.spawnSync([join(ctx.bin, 'gh'), 'attestation', 'verify', 'imp']).exitCode).toBe(1);
});

test('it succeeds any other command', () => {
  using ctx = setupTest();

  createStubGhAttestation({ bin: ctx.bin, loggedIn: false, verifies: false });

  expect(Bun.spawnSync([join(ctx.bin, 'gh'), 'release', 'list']).exitCode).toBe(0);
});

test('it records the arguments of each call in order', () => {
  using ctx = setupTest();

  const gh = createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  Bun.spawnSync([join(ctx.bin, 'gh'), 'auth', 'status']);
  Bun.spawnSync([join(ctx.bin, 'gh'), 'attestation', 'verify', 'imp', '-R', 'zgeoff/imp']);

  expect(gh.readCalls()).toStrictEqual(['auth status', 'attestation verify imp -R zgeoff/imp']);
});

test('it records no calls before the first', () => {
  using ctx = setupTest();

  const gh = createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  expect(gh.readCalls()).toStrictEqual([]);
});
