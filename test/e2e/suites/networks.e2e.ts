import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// Private networks between imps (docs/guides/networks.md) in real guests.
// web is open and db is box, so a network reaches past both policies; out
// is on no network.

const prefix = setupSuite('networks');
const TINY = resolveImageName('e2e-tiny');
const web = `${prefix}web`;
const db = `${prefix}db`;
const out = `${prefix}out`;

// networks are the host's, not an imp's: a run cut short leaves them
const LAB = 'e2e-net-lab';
const OPS = 'e2e-net-ops';
const ips = { web: '', db: '', out: '' };

// what `imp net join` said when it put box db next to open web
const joined = { stderr: '' };

async function removeNetworks(): Promise<void> {
  for (const network of [LAB, OPS]) {
    await tryImp(['net', 'rm', network]);
  }
}

beforeAll(async () => {
  await removeNetworks();
  await runImp('net', 'create', LAB);
  await createImp(web, '--image', TINY, '--memory', '256', '--net', LAB);

  await createImp(
    db,
    '--image',
    TINY,
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  await createImp(out, '--image', TINY, '--memory', '256');

  for (const name of [web, db, out]) {
    await holdImp(name);
  }

  const join = await tryImp(['net', 'join', LAB, db]);

  if (join.exitCode !== 0) {
    throw new Error(`imp net join exited ${String(join.exitCode)}: ${join.stderr}`);
  }

  joined.stderr = join.stderr;

  const rows = [await requireImp(web), await requireImp(db), await requireImp(out)];

  ips.web = rows[0]?.ip ?? '';
  ips.db = rows[1]?.ip ?? '';
  ips.out = rows[2]?.ip ?? '';
}, 600_000);

afterAll(async () => {
  await removeNetworks();
});

// the shell exits 0 when the command did
async function tryInImp(name: string, script: string): Promise<boolean> {
  const result = await tryImp(['exec', name, '--', 'sh', '-c', script]);

  return result.exitCode === 0;
}

function tryPing(name: string, ip: string): Promise<boolean> {
  return tryInImp(name, `ping -c 1 -W 2 ${ip} >/dev/null`);
}

// a one-shot TCP listener in the guest, which writes what it got to `file`
async function startListener(name: string, port: number, file: string): Promise<void> {
  await runShellInImp(
    name,
    `rm -f ${file}; setsid sh -c 'nc -l -p ${String(port)} > ${file}' </dev/null >/dev/null 2>&1 &`,
  );

  await Bun.sleep(300);
}

// what busybox nslookup printed, its errors included
async function resolveInImp(name: string, query: string): Promise<string> {
  const result = await tryImp(['exec', name, '--', 'nslookup', query]);

  return result.stdout + result.stderr;
}

// Tcp EstabResets from the guest's /proc/net/snmp
async function readEstabResets(name: string): Promise<number> {
  const text = await runShellInImp(name, 'grep ^Tcp: /proc/net/snmp');

  const [header = '', values = ''] = text.split('\n');
  const column = header.split(' ').indexOf('EstabResets');

  return Number(values.split(' ')[column]);
}

test('the imps on a network reach each other, whatever their policies', async () => {
  const reached = [await tryPing(web, ips.db), await tryPing(db, ips.web)];

  await startListener(web, 7000, '/tmp/got');
  await runShellInImp(db, `echo hello | nc -w 2 ${ips.web} 7000`);

  const got = await runShellInImp(web, 'cat /tmp/got');

  expect(reached).toEqual([true, true]);
  expect(got).toBe('hello');
});

test('a join that puts a box imp next to an open one warns', () => {
  expect(joined.stderr).toContain(`warning: ${db} is box, but ${web} on ${LAB} is open`);
});

test('an imp on no network reaches neither, and neither reaches it', async () => {
  const reached = [
    await tryPing(out, ips.web),
    await tryPing(out, ips.db),
    await tryPing(web, ips.out),
    await tryPing(db, ips.out),
  ];

  expect(reached).toEqual([false, false, false, false]);
});

test('a network does not open the internet to a box imp', async () => {
  const fetched = [
    await tryInImp(db, 'wget -q -T 5 -O /dev/null http://example.com/'),
    await tryInImp(db, 'wget -q -T 5 -O /dev/null http://example.org/'),
  ];

  expect(fetched).toEqual([true, false]);
});

test('impd names the peers, by network and by bare name, for open and box imps', async () => {
  const fromWeb = await resolveInImp(web, `${db}.${LAB}.internal`);
  const bare = await resolveInImp(web, db);
  const fromDb = await resolveInImp(db, `${web}.${LAB}.internal`);
  const reverse = await resolveInImp(db, ips.web);

  expect(fromWeb).toContain(`Address: ${ips.db}`);
  expect(bare).toContain(`Address: ${ips.db}`);
  expect(fromDb).toContain(`Address: ${ips.web}`);
  expect(reverse).toContain(`${web}.${LAB}.internal`);
});

test('an imp on no network gets NXDOMAIN for a peer name', async () => {
  const answer = await resolveInImp(out, `${db}.${LAB}.internal`);

  expect(answer).toContain('NXDOMAIN');
  expect(answer).not.toContain(ips.db);
});

test("a query to a peer's own port 53 reaches the peer, not impd", async () => {
  await startListener(web, 53, '/tmp/dns');
  await runShellInImp(db, `echo query | nc -w 2 ${ips.web} 53`);

  const got = await runShellInImp(web, 'cat /tmp/dns');

  expect(got).toBe('query');
});

test('a leave ends a held connection with a reset, and shuts the pair out', async () => {
  await startListener(web, 7001, '/tmp/held');

  // writes every 200 ms until something ends it, then records nc's exit code
  await runShellInImp(
    db,
    `rm -f /tmp/peer-*; setsid sh -c '(while sleep 0.2; do echo x; done | nc ${ips.web} 7001; echo $? > /tmp/peer-done)' </dev/null >/dev/null 2>&1 &`,
  );

  await waitFor('the held connection to carry data', async () => {
    const carried = await tryInImp(web, 'test -s /tmp/held');

    expect(carried).toBeTrue();
  });

  const before = await readEstabResets(db);

  await runImp('net', 'leave', LAB, db);

  // busybox nc says nothing on a reset; the kernel counts an established
  // connection that a RST ended, and a FIN never
  await waitFor('the guest to see its connection reset', async () => {
    const code = await runShellInImp(db, 'cat /tmp/peer-done 2>/dev/null || true');
    const after = await readEstabResets(db);

    expect([code !== '' && code !== '0', after > before]).toEqual([true, true]);
  });

  const reached = [await tryPing(db, ips.web), await tryPing(web, ips.db)];

  const name = await resolveInImp(web, `${db}.${LAB}.internal`);

  expect(reached).toEqual([false, false]);
  expect(name).toContain('NXDOMAIN');
});

test('two networks join a pair; deleting one of them leaves the other', async () => {
  await runImp('net', 'create', OPS);
  await runImp('net', 'join', LAB, db);
  await runImp('net', 'join', OPS, db);
  await runImp('net', 'join', OPS, web);
  await runImp('net', 'rm', LAB);

  const stillReached = await tryPing(db, ips.web);
  const listed = await runImp('net', 'ls', '--json');

  await runImp('net', 'rm', OPS);

  const parted = await tryPing(db, ips.web);

  expect(stillReached).toBeTrue();
  expect(JSON.parse(listed)).toEqual([expect.objectContaining({ name: OPS, imps: [db, web] })]);
  expect(parted).toBeFalse();
});
