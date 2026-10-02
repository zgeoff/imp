import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { createAuthorizedKeys, parseAuthorizedKeys } from './authorized-keys';
import { createEd25519Key } from './host-key';

const KEY = createEd25519Key().public;

test('it reads key lines and keeps their comments', () => {
  const parsed = parseAuthorizedKeys(`# laptop\n\n${KEY} me@laptop\n`);

  expect(parsed.problems).toEqual([]);
  expect(parsed.keys).toHaveLength(1);
  expect(parsed.keys[0]?.type).toBe('ssh-ed25519');
  expect(parsed.keys[0]?.comment).toBe('me@laptop');
});

test('it refuses a line with options, which it cannot enforce', () => {
  const parsed = parseAuthorizedKeys(
    [`from="10.0.0.1" ${KEY}`, `command="true" ${KEY}`, `restrict ${KEY}`].join('\n'),
  );

  expect(parsed.keys).toEqual([]);

  expect(parsed.problems).toEqual([
    'line 1: options are not supported; put the key type first',
    'line 2: options are not supported; put the key type first',
    'line 3: options are not supported; put the key type first',
  ]);
});

test('it refuses key types the gateway cannot verify, and broken keys', () => {
  const parsed = parseAuthorizedKeys(
    'sk-ssh-ed25519@openssh.com AAAA me\nssh-dss AAAA me\nssh-ed25519 bm90IGEga2V5 me\n',
  );

  expect(parsed.keys).toEqual([]);
  expect(parsed.problems).toHaveLength(3);
  expect(parsed.problems[0]).toBe('line 1: sk-ssh-ed25519@openssh.com keys are not supported');
  expect(parsed.problems[2]).toStartWith('line 3: ');
});

test('a file others can write lists its keys but grants none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-keys-'));
  const path = join(dir, 'authorized_keys');
  const parsed = utils.parseKey(KEY);

  if (parsed instanceof Error) {
    throw parsed;
  }

  const blob = parsed.getPublicSSH();

  try {
    chmodSync(dir, 0o700);
    writeFileSync(path, `${KEY}\n`, { mode: 0o600 });
    chmodSync(path, 0o666);

    const keys = createAuthorizedKeys(path, () => {});

    expect(keys.findKey(blob)).toBeNull();
    expect(keys.isListed(blob)).toBeTrue();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
