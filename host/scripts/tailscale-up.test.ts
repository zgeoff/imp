import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';

// A tailscale stand-in, after the --socket the script always passes first:
// `status` prints the node in $STUB_STATUS, and `up` saves the node it joins
// as there.
const STUB_TAILSCALE = String.raw`shift
case $1 in
  status) cat "$STUB_STATUS" ;;
  up)
    hostname= tags=
    for arg in "$@"; do
      case $arg in
        --hostname=* | --advertise-tags=*) declare "$(cut -c3- <<<"$arg" | sed 's/^advertise-//')" ;;
      esac
    done
    jq -n --arg host "$hostname" --arg tags "$tags" \
      '{BackendState: "Running", Self: {HostName: $host, Tags: ($tags | split(",")), TailscaleIPs: ["100.64.0.9"], DNSName: "imp.tail1234.ts.net."}}' \
      >"$STUB_STATUS"
    ;;
esac`;

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-tailscale-up-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const stateDir = join(dir, 'state');
  const status = join(dir, 'status.json');
  const resolvConf = join(dir, 'resolv.conf');

  mkdirSync(stateDir);
  writeFileSync(join(stateDir, 'tailscaled.state'), 'saved');
  writeFileSync(resolvConf, 'nameserver 127.0.0.11\n');

  // tailscaled runs already
  createStubBin(dir, 'ps', 'echo S');

  const stub = createStubBin(dir, 'tailscale', STUB_TAILSCALE);

  // a saved node that is Running as `hostname` with `tags`
  function saveNode(hostname: string, tags: readonly string[]): void {
    writeFileSync(
      status,
      JSON.stringify({
        BackendState: 'Running',
        Self: {
          HostName: hostname,
          Tags: tags,
          TailscaleIPs: ['100.64.0.7'],
          DNSName: 'imp.tail1234.ts.net.',
        },
      }),
    );
  }

  function runUp(env: Readonly<Record<string, string>>) {
    return Bun.spawnSync([new URL('tailscale-up.sh', import.meta.url).pathname], {
      env: {
        PATH: `${stub.bin}:${process.env['PATH'] ?? ''}`,
        STUB_STATUS: status,
        IMP_RESOLV_CONF: resolvConf,
        IMP_TAILSCALE_STATE_DIR: stateDir,
        IMP_TAILSCALE_HOSTNAME: 'imp',
        ...env,
      },
    });
  }

  function readUpCalls(): string[] {
    return readFileSync(stub.calls, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('tailscale ') && line.includes(' up '));
  }

  function readNodeTags(): unknown {
    return JSON.parse(readFileSync(status, 'utf8')).Self.Tags;
  }

  return { saveNode, runUp, readUpCalls, readNodeTags };
}

test('it joins again with the key when the saved node holds other tags than it asks for', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);

  const result = ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key', IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(result.exitCode).toBe(0);
  expect(ctx.readUpCalls()).toHaveLength(1);
  expect(ctx.readUpCalls()[0]).toContain('--force-reauth');
  expect(ctx.readNodeTags()).toStrictEqual(['tag:imp-e2e']);
});

test('it keeps the saved node when it holds the tags it asks for, in any order', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:b', 'tag:a']);

  const result = ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key', IMP_TAILSCALE_TAGS: 'tag:a,tag:b' });

  expect(result.exitCode).toBe(0);
  expect(ctx.readUpCalls()).toStrictEqual([]);
});

test('it keeps a saved tag:imp node with the key when no tags are asked for', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);

  const result = ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key' });

  expect(result.exitCode).toBe(0);
  expect(ctx.readUpCalls()).toStrictEqual([]);
});

test('it fails without a key when the saved node holds other tags than it asks for', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);

  const result = ctx.runUp({ IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    'tailscale-up: the saved node holds tag:imp, not tag:imp-e2e; give an auth key to join again\n',
  );

  expect(ctx.readUpCalls()).toStrictEqual([]);
});

test('it never puts the key on the command line', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);
  ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key', IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(ctx.readUpCalls().join('\n')).not.toContain('fake-key');
});
