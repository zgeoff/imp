import { expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { listImageNames, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp, holdImp, readGuestFile, removeImps, writeGuestFile } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';

// `imp template` (docs/guides/templates.md) on the e2e-git image, which has
// ssh-keygen. Its USER is `dev`, so root's steps go through sudo.

const prefix = setupSuite('templates');
const GIT = resolveImageName('e2e-git');
const source = `${prefix}src`;
const template = `${prefix}golden`;
const first = `${prefix}a`;
const second = `${prefix}b`;
const SOURCE_ID = '0123456789abcdef0123456789abcdef';

// the machine-id, and the fingerprint of the ed25519 host key
async function readIdentity(name: string): Promise<{ machineId: string; hostKey: string }> {
  const machineId = await readGuestFile(name, '/etc/machine-id');

  const hostKey = await runShellInImp(
    name,
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f2",
  );

  return { machineId, hostKey };
}

test('a template copies the disk, and each copy gets its own identity', async () => {
  await createImp(source, '--image', GIT, '--memory', '512');
  await holdImp(source);

  await runShellInImp(
    source,
    `echo ${SOURCE_ID} | sudo tee /etc/machine-id >/dev/null && sudo ssh-keygen -A >/dev/null`,
  );

  await writeGuestFile(source, '/home/dev/marker', 'golden');

  const sourceIdentity = await readIdentity(source);

  expect(sourceIdentity.machineId).toBe(SOURCE_ID);
  expect(sourceIdentity.hostKey).toStartWith('SHA256:');

  // the source is running: impd freezes it around the clone
  await runImp('template', 'create', source, template);

  const templates = await runImp('template', 'ls');

  expect(templates).toContain(template);
  expect(templates).toContain(`imp:${source}`);

  await createImp(first, '--image', template, '--memory', '512');
  await createImp(second, '--image', template, '--memory', '512');

  const firstIdentity = await readIdentity(first);
  const secondIdentity = await readIdentity(second);

  for (const copy of [firstIdentity, secondIdentity]) {
    expect(copy.machineId).toMatch(/^[\da-f]{32}$/);
    expect(copy.machineId).not.toBe(SOURCE_ID);
    expect(copy.hostKey).toStartWith('SHA256:');
    expect(copy.hostKey).not.toBe(sourceIdentity.hostKey);
  }

  expect(firstIdentity.machineId).not.toBe(secondIdentity.machineId);
  expect(firstIdentity.hostKey).not.toBe(secondIdentity.hostKey);

  const marker = await readGuestFile(first, '/home/dev/marker');

  expect(marker).toBe('golden');

  // a later boot keeps the identity the first one made
  await runImp('stop', first);
  await runImp('start', first);

  const rebooted = await readIdentity(first);

  expect(rebooted).toEqual(firstIdentity);
});

test('a template in use cannot be removed; one with no imps can', async () => {
  const inUse = await tryImp(['template', 'rm', template]);

  expect(inUse.exitCode).toBe(1);
  expect(inUse.stderr).toContain('used by 2 imp(s)');

  await removeImps(first, second);
  await runImp('template', 'rm', template);

  const images = await listImageNames();

  expect(images).not.toContain(template);
});
