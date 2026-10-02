import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { createEd25519Key, loadOrCreateHostKey, readFingerprint, setupSshDir } from './host-key';

test('the host key is made once, owner-only, and stays the same', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'imp-hostkey-'));

  try {
    const sshDir = setupSshDir(dataDir);
    const first = loadOrCreateHostKey(sshDir);
    const second = loadOrCreateHostKey(sshDir);

    expect(second).toBe(first);
    expect(statSync(join(sshDir, 'host_key')).mode & 0o777).toBe(0o600);
    expect(statSync(sshDir).mode & 0o777).toBe(0o700);
    expect(readFingerprint(first)).toMatch(/^SHA256:[\w+/]{43}$/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ssh2's own generator makes an unreadable key about once in 256
test('every key it makes reads back', () => {
  const unreadable = Array.from({ length: 1000 }, () => createEd25519Key()).filter(
    (pair) => utils.parseKey(pair.private) instanceof Error,
  );

  expect(unreadable).toEqual([]);
});
