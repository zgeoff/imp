import { expect, test } from 'bun:test';
import { REFUSED_RANGES } from '../../packages/daemon/src/broker/tunnel-target';
import { buildElementChange, buildRuleset } from '../../packages/daemon/src/egress/egress-ruleset';
import type { FirewallSlot } from '../../packages/daemon/src/egress/egress-ruleset';

// impd's table, applied by the real nft in a fresh user and network
// namespace. Skipped where that is not allowed, or nft is missing.
const canUnshare =
  Bun.spawnSync(['unshare', '-rn', 'nft', 'list', 'ruleset'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const PRIVATE = [
  ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
  '10.66.0.0/16',
];

const SLOTS: readonly FirewallSlot[] = [
  { slot: 0, tap: 'imp0', guestIp: '10.66.0.2', mode: 'open', cidrs: [], addresses: [] },
  {
    slot: 1,
    tap: 'imp1',
    guestIp: '10.66.0.6',
    mode: 'box',
    cidrs: ['172.17.0.1/32'],
    addresses: ['140.82.112.3'],
  },
  { slot: 2, tap: 'imp2', guestIp: '10.66.0.10', mode: 'none', cidrs: [], addresses: [] },
];

function runNft(scripts: Readonly<Record<string, string>>, after: string): string {
  const result = Bun.spawnSync(['unshare', '-rn', 'bash', '-euo', 'pipefail', '-c', after], {
    env: { ...process.env, ...scripts },
  });

  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);

  return result.stdout.toString();
}

test.skipIf(!canUnshare)('the table applies over itself, and takes element changes', () => {
  const first = buildRuleset({
    privateRanges: PRIVATE,
    dnsPort: 7053,
    setSize: 4096,
    slots: SLOTS,
  });

  // slot 1 gone, as after an imp rm: its set and its map entry go with it
  const second = buildRuleset({
    privateRanges: PRIVATE,
    dnsPort: 7053,
    setSize: 4096,
    slots: SLOTS.filter((slot) => slot.slot !== 1),
  });

  const changes =
    buildElementChange('add', 1, ['192.0.2.7', '192.0.2.8']) +
    buildElementChange('delete', 1, ['140.82.112.3']);

  const listed = runNft(
    { FIRST: first, CHANGES: changes, SECOND: second },
    `
printf '%s' "$FIRST" | nft -f -
printf '%s' "$FIRST" | nft -f -
printf '%s' "$CHANGES" | nft -f -
nft list set inet imp_egress allow1 | grep elements
nft list map inet imp_egress slots | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
printf '%s' "$SECOND" | nft -f -
nft list map inet imp_egress slots | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
nft list set inet imp_egress allow1 2>&1 | head -1 || true
`,
  );

  expect(listed.split('\n').map((line) => line.trim())).toEqual([
    'elements = { 192.0.2.7, 192.0.2.8 }',
    'elements = { "imp0" : jump slot0, "imp1" : jump slot1, "imp2" : jump slot2 }',
    'elements = { "imp0" : jump slot0, "imp2" : jump slot2 }',
    'Error: No such file or directory',
    '',
  ]);
});
