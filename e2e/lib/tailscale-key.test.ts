import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { hasTailscaleE2EKey, readTailscaleE2EAuthKey } from './tailscale-key';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-tskey-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('#readTailscaleE2EAuthKey reads the e2e client as an ephemeral, preauthorized key with its tag', async () => {
  updateEnv('IMP_E2E_TAILSCALE_AUTHKEY', 'fake-client-secret');

  const found = await readTailscaleE2EAuthKey();

  expect(found).toStrictEqual({
    key: 'fake-client-secret?ephemeral=true&preauthorized=true',
    tags: 'tag:imp-e2e',
  });
});

test('#readTailscaleE2EAuthKey reads no key when neither the env nor op has the e2e client', async () => {
  const ctx = setupTest();

  // 1Password without the item
  const op = createStubBin(ctx.dir, 'op', 'exit 1');

  updateEnv('PATH', `${op.bin}:${process.env['PATH'] ?? ''}`);
  updateEnv('IMP_E2E_TAILSCALE_AUTHKEY', undefined);

  const found = await readTailscaleE2EAuthKey();

  expect(found).toBeNull();
});

test('#hasTailscaleE2EKey holds for a key with the tag:imp-e2e tag', () => {
  updateEnv('TAILSCALE_AUTHKEY', 'fake-client-secret?ephemeral=true&preauthorized=true');
  updateEnv('IMP_TAILSCALE_TAGS', 'tag:imp-e2e');

  expect(hasTailscaleE2EKey()).toBeTrue();
});

test("#hasTailscaleE2EKey fails for dev's tag:imp key", () => {
  updateEnv('TAILSCALE_AUTHKEY', 'fake-tag-imp-key');
  updateEnv('IMP_TAILSCALE_TAGS', 'tag:imp');

  expect(hasTailscaleE2EKey()).toBeFalse();
});

test('#hasTailscaleE2EKey fails for the e2e tag without a key', () => {
  updateEnv('TAILSCALE_AUTHKEY', undefined);
  updateEnv('IMP_TAILSCALE_TAGS', 'tag:imp-e2e');

  expect(hasTailscaleE2EKey()).toBeFalse();
});
