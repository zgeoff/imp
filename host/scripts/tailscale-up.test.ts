import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';

// A tailscale stand-in, after the --socket the script always passes first:
// `status` prints the node in $STUB_STATUS, or Starting while $STUB_STARTING
// exists; `up` saves the node it joins as there, and `down` stops it.
const STUB_TAILSCALE = String.raw`shift
case $1 in
  status)
    if [ -e "$STUB_STARTING" ]; then
      echo '{"BackendState": "Starting"}'
    else
      cat "$STUB_STATUS"
    fi
    ;;
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
  down)
    jq '.BackendState = "Stopped"' "$STUB_STATUS" >"$STUB_STATUS.new"
    mv "$STUB_STATUS.new" "$STUB_STATUS"
    ;;
esac`;

const SCRIPT = new URL('tailscale-up.sh', import.meta.url).pathname;

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-tailscale-up-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const stateDir = join(dir, 'state');
  const status = join(dir, 'status.json');
  const starting = join(dir, 'starting');
  const resolvConf = join(dir, 'resolv.conf');
  const out = join(dir, 'out');
  const err = join(dir, 'err');

  mkdirSync(stateDir);
  writeFileSync(join(stateDir, 'tailscaled.state'), 'saved');
  writeFileSync(resolvConf, 'nameserver 127.0.0.11\n');

  // tailscaled runs already, and the script's waits pass at once
  createStubBin(dir, 'ps', 'echo S');
  createStubBin(dir, 'sleep');

  const stub = createStubBin(dir, 'tailscale', STUB_TAILSCALE);

  // a node that is Running as `hostname` with `tags`
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

  // the saved node stays Starting until releaseStart
  function holdStart(): void {
    writeFileSync(starting, '');
  }

  function releaseStart(): void {
    rmSync(starting);
  }

  // Runs the script with its output in files, so a wait it leaves in the
  // background holds no pipe open.
  function runUp(env: Readonly<Record<string, string>>): number {
    const result = Bun.spawnSync(['bash', '-c', '"$0" >"$1" 2>"$2"', SCRIPT, out, err], {
      env: {
        PATH: `${stub.bin}:${process.env['PATH'] ?? ''}`,
        STUB_STATUS: status,
        STUB_STARTING: starting,
        IMP_RESOLV_CONF: resolvConf,
        IMP_TAILSCALE_STATE_DIR: stateDir,
        IMP_TAILSCALE_HOSTNAME: 'imp',
        ...env,
      },
    });

    return result.exitCode;
  }

  // the tailscale calls with this verb
  function readCalls(verb: string): string[] {
    return readFileSync(stub.calls, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('tailscale ') && line.split(' ')[2] === verb);
  }

  function readNode(): { BackendState: string; Self: { Tags: string[] } } {
    return JSON.parse(readFileSync(status, 'utf8'));
  }

  function readStdout(): string {
    return readFileSync(out, 'utf8');
  }

  function readStderr(): string {
    return readFileSync(err, 'utf8');
  }

  return {
    saveNode,
    holdStart,
    releaseStart,
    runUp,
    readCalls,
    readNode,
    readStdout,
    readStderr,
  };
}

test('it joins again with the key when the saved node holds other tags than it asks for', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);

  const exitCode = ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key', IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(exitCode).toBe(0);
  expect(ctx.readCalls('up')).toHaveLength(1);
  expect(ctx.readCalls('up')[0]).toContain('--force-reauth');
  expect(ctx.readNode().Self.Tags).toStrictEqual(['tag:imp-e2e']);
});

test('it keeps the saved node when it holds the tags it asks for, in any order', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:b', 'tag:a']);

  const exitCode = ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key', IMP_TAILSCALE_TAGS: 'tag:a,tag:b' });

  expect(exitCode).toBe(0);
  expect(ctx.readCalls('up')).toStrictEqual([]);
});

test('it keeps a saved tag:imp node with the key when no tags are asked for', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);

  const exitCode = ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key' });

  expect(exitCode).toBe(0);
  expect(ctx.readCalls('up')).toStrictEqual([]);
});

test('it takes the saved node down and fails without a key when it holds other tags', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);

  const exitCode = ctx.runUp({ IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(exitCode).toBe(1);

  expect(ctx.readStderr()).toBe(
    'tailscale-up: the node holds tag:imp, not tag:imp-e2e; give an auth key to join again\n',
  );

  expect(ctx.readCalls('up')).toStrictEqual([]);
  expect(ctx.readNode().BackendState).toBe('Stopped');
});

test('it takes a node in memory down without a key or state when it holds other tags', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);

  const exitCode = ctx.runUp({ IMP_TAILSCALE_STATE_DIR: 'mem', IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(exitCode).toBe(1);

  expect(ctx.readStderr()).toBe(
    'tailscale-up: the node holds tag:imp, not tag:imp-e2e; give an auth key to join again\n',
  );

  expect(ctx.readNode().BackendState).toBe('Stopped');
});

test('it takes a node in memory down without a key or state while it is not Running yet', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);
  ctx.holdStart();

  const exitCode = ctx.runUp({ IMP_TAILSCALE_STATE_DIR: 'mem', IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(exitCode).toBe(1);

  expect(ctx.readStderr()).toBe(
    'tailscale-up: the node in memory is not Running, so its tags are unchecked; taking it down\n',
  );

  expect(ctx.readCalls('down')).toHaveLength(1);
});

test('it takes the node down when it is not Running after it joins, when it asks for tags', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', []);
  ctx.holdStart();

  const exitCode = ctx.runUp({
    IMP_TAILSCALE_STATE_DIR: 'mem',
    TAILSCALE_AUTHKEY: 'fake-key',
    IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
  });

  expect(exitCode).toBe(1);

  expect(ctx.readStderr()).toBe(
    'tailscale-up: backend state Starting, not Running; taking it down, since its tags are unchecked\n',
  );

  expect(ctx.readCalls('up')).toHaveLength(1);
  expect(ctx.readCalls('down')).toHaveLength(1);
});

test('it joins again with the key once a slow saved node is Running with other tags', async () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);
  ctx.holdStart();

  const exitCode = ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key', IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(exitCode).toBe(0);
  expect(ctx.readStdout()).toContain('waiting for it in the background');

  ctx.releaseStart();

  const up = await waitFor(
    () => {
      const [call] = ctx.readCalls('up');

      if (call === undefined) {
        throw new Error('no tailscale up yet');
      }

      return call;
    },
    { timeoutMs: 20_000 },
  );

  expect(up).toContain('--force-reauth');

  await waitFor(() => {
    expect(ctx.readNode().Self.Tags).toStrictEqual(['tag:imp-e2e']);
  });
}, 30_000);

test('it takes a slow saved node down without a key once it is Running with other tags', async () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);
  ctx.holdStart();

  const exitCode = ctx.runUp({ IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(exitCode).toBe(0);

  ctx.releaseStart();

  await waitFor(
    () => {
      expect(ctx.readNode().BackendState).toBe('Stopped');
    },
    { timeoutMs: 20_000 },
  );

  expect(ctx.readStderr()).toBe(
    'tailscale-up: the node holds tag:imp, not tag:imp-e2e; give an auth key to join again\n',
  );

  expect(ctx.readCalls('up')).toStrictEqual([]);
}, 30_000);

test('it takes a saved node down that is still not Running after the wait, when it asks for tags', async () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);
  ctx.holdStart();

  const exitCode = ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key', IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(exitCode).toBe(0);

  await waitFor(
    () => {
      expect(ctx.readCalls('down')).toHaveLength(1);
    },
    { timeoutMs: 20_000 },
  );

  expect(ctx.readStderr()).toBe(
    'tailscale-up: the saved node is still Starting after 30 min; taking it down, since its tags are unchecked\n',
  );
}, 30_000);

test('it never puts the key on the command line', () => {
  const ctx = setupTest();

  ctx.saveNode('imp', ['tag:imp']);
  ctx.runUp({ TAILSCALE_AUTHKEY: 'fake-key', IMP_TAILSCALE_TAGS: 'tag:imp-e2e' });

  expect(ctx.readCalls('up').join('\n')).not.toContain('fake-key');
});
