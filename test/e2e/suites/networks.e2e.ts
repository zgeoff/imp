import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { readEstabResets, waitForGuestListen } from '../lib/guest-net';
import { createInstanceClient, requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent, removeNetworkIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// Private networks between imps (docs/guides/networks.md) in real guests.
// web is open and db is box, so a network reaches past both policies.

// one stack for every release, so each imp goes before its network
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('networks'), stack, client };
}

test('it lets the imps on a network reach and name each other past their policies, and nobody else', async () => {
  const ctx = await setupTest();

  const lab = `${ctx.prefix}lab`;
  const web = `${ctx.prefix}web`;
  const db = `${ctx.prefix}db`;

  // on no network
  const out = `${ctx.prefix}out`;

  await runImp('net', 'create', lab);

  registerRemoval(ctx.stack, config.keep, () => removeNetworkIfPresent(ctx.client, lab));

  await runImp(
    'new',
    web,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--net',
    lab,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, web));

  await runImp(
    'new',
    db,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, db));

  await runImp('new', out, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, out));

  await waitForExec(web);
  await waitForExec(db);
  await waitForExec(out);
  await holdImp(web);
  await holdImp(db);
  await holdImp(out);

  // a join that puts a box imp next to an open one warns
  const joined = await tryImp(['net', 'join', lab, db]);

  expect(joined.exitCode).toBe(0);
  expect(joined.stderr).toContain(`warning: ${db} is box, but ${web} on ${lab} is open`);

  const webRow = await requireImp(web);
  const dbRow = await requireImp(db);
  const outRow = await requireImp(out);

  const webIp = webRow.ip;
  const dbIp = dbRow.ip;
  const outIp = outRow.ip;

  // the imps on the network reach each other, whatever their policies
  const webToDb = await tryImp(['exec', web, '--', 'ping', '-c', '1', '-W', '2', dbIp]);
  const dbToWeb = await tryImp(['exec', db, '--', 'ping', '-c', '1', '-W', '2', webIp]);

  await runShellInImp(
    web,
    `rm -f /tmp/got; setsid sh -c 'nc -l -p 7000 > /tmp/got' </dev/null >/dev/null 2>&1 &`,
  );

  await waitForGuestListen(web, 7000);
  await runShellInImp(db, `echo hello | nc -w 2 ${webIp} 7000`);

  const got = await runShellInImp(web, 'cat /tmp/got');

  expect(webToDb.exitCode).toBe(0);
  expect(dbToWeb.exitCode).toBe(0);
  expect(got).toBe('hello');

  // an imp on no network reaches neither, and neither reaches it
  const outToWeb = await tryImp(['exec', out, '--', 'ping', '-c', '1', '-W', '2', webIp]);
  const outToDb = await tryImp(['exec', out, '--', 'ping', '-c', '1', '-W', '2', dbIp]);
  const webToOut = await tryImp(['exec', web, '--', 'ping', '-c', '1', '-W', '2', outIp]);
  const dbToOut = await tryImp(['exec', db, '--', 'ping', '-c', '1', '-W', '2', outIp]);

  expect(outToWeb.exitCode).not.toBe(0);
  expect(outToDb.exitCode).not.toBe(0);
  expect(webToOut.exitCode).not.toBe(0);
  expect(dbToOut.exitCode).not.toBe(0);

  // a network does not open the internet to a box imp
  const allowed = await tryImp([
    'exec',
    db,
    '--',
    'wget',
    '-q',
    '-T',
    '5',
    '-O',
    '/dev/null',
    'http://example.com/',
  ]);

  const blocked = await tryImp([
    'exec',
    db,
    '--',
    'wget',
    '-q',
    '-T',
    '5',
    '-O',
    '/dev/null',
    'http://example.org/',
  ]);

  expect(allowed.exitCode).toBe(0);
  expect(blocked.exitCode).not.toBe(0);

  // impd names the peers, by network and by bare name, for open and box imps;
  // busybox nslookup prints some answers on stderr
  const fromWeb = await tryImp(['exec', web, '--', 'nslookup', `${db}.${lab}.internal`]);
  const bare = await tryImp(['exec', web, '--', 'nslookup', db]);
  const fromDb = await tryImp(['exec', db, '--', 'nslookup', `${web}.${lab}.internal`]);
  const reverse = await tryImp(['exec', db, '--', 'nslookup', webIp]);
  const fromOut = await tryImp(['exec', out, '--', 'nslookup', `${db}.${lab}.internal`]);

  expect(`${fromWeb.stdout}${fromWeb.stderr}`).toContain(`Address: ${dbIp}`);
  expect(`${bare.stdout}${bare.stderr}`).toContain(`Address: ${dbIp}`);
  expect(`${fromDb.stdout}${fromDb.stderr}`).toContain(`Address: ${webIp}`);
  expect(`${reverse.stdout}${reverse.stderr}`).toContain(`${web}.${lab}.internal`);

  // an imp on no network gets NXDOMAIN for a peer name
  expect(`${fromOut.stdout}${fromOut.stderr}`).toContain('NXDOMAIN');
  expect(`${fromOut.stdout}${fromOut.stderr}`).not.toContain(dbIp);

  // a query to a peer's own port 53 reaches the peer, not impd
  await runShellInImp(
    web,
    `rm -f /tmp/dns; setsid sh -c 'nc -l -p 53 > /tmp/dns' </dev/null >/dev/null 2>&1 &`,
  );

  await waitForGuestListen(web, 53);
  await runShellInImp(db, `echo query | nc -w 2 ${webIp} 53`);

  const dns = await runShellInImp(web, 'cat /tmp/dns');

  expect(dns).toBe('query');
});

test('it ends a held connection with a reset on a leave, and shuts the pair out', async () => {
  const ctx = await setupTest();

  const lab = `${ctx.prefix}leave`;
  const web = `${ctx.prefix}lweb`;
  const db = `${ctx.prefix}ldb`;

  await runImp('net', 'create', lab);

  registerRemoval(ctx.stack, config.keep, () => removeNetworkIfPresent(ctx.client, lab));

  await runImp(
    'new',
    web,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--net',
    lab,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, web));

  await runImp('new', db, '--image', resolveImageName('e2e-tiny'), '--memory', '256', '--net', lab);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, db));

  await waitForExec(web);
  await waitForExec(db);
  await holdImp(web);
  await holdImp(db);

  const webRow = await requireImp(web);
  const dbRow = await requireImp(db);

  const webIp = webRow.ip;
  const dbIp = dbRow.ip;

  await runShellInImp(
    web,
    `rm -f /tmp/held; setsid sh -c 'nc -l -p 7001 > /tmp/held' </dev/null >/dev/null 2>&1 &`,
  );

  await waitForGuestListen(web, 7001);

  // the workload: a write every 200 ms until something ends the connection,
  // then nc's exit code in /tmp/peer-done
  await runShellInImp(
    db,
    `rm -f /tmp/peer-*; setsid sh -c '(while sleep 0.2; do echo x; done | nc ${webIp} 7001; echo $? > /tmp/peer-done)' </dev/null >/dev/null 2>&1 &`,
  );

  await waitFor('the held connection to carry data', () => runShellInImp(web, 'test -s /tmp/held'));

  const before = await readEstabResets(db);

  await runImp('net', 'leave', lab, db);

  // busybox nc says nothing on a reset; the kernel counts an established
  // connection that a RST ended, and a FIN never
  const ended = await waitFor('the guest to see its connection reset', async () => {
    const code = await runShellInImp(db, 'cat /tmp/peer-done 2>/dev/null || true');
    const resets = await readEstabResets(db);

    if (code === '' || resets <= before) {
      throw new Error(
        `nc exit ${JSON.stringify(code)}, resets ${String(before)} -> ${String(resets)}`,
      );
    }

    return { code, resets };
  });

  const dbToWeb = await tryImp(['exec', db, '--', 'ping', '-c', '1', '-W', '2', webIp]);
  const webToDb = await tryImp(['exec', web, '--', 'ping', '-c', '1', '-W', '2', dbIp]);
  const name = await tryImp(['exec', web, '--', 'nslookup', `${db}.${lab}.internal`]);

  expect(ended.code).not.toBe('0');
  expect(ended.resets).toBeGreaterThan(before);
  expect(dbToWeb.exitCode).not.toBe(0);
  expect(webToDb.exitCode).not.toBe(0);
  expect(`${name.stdout}${name.stderr}`).toContain('NXDOMAIN');
});

test('it keeps a pair that two networks join on the other one when one is deleted', async () => {
  const ctx = await setupTest();

  const lab = `${ctx.prefix}two-lab`;
  const ops = `${ctx.prefix}two-ops`;
  const web = `${ctx.prefix}tweb`;
  const db = `${ctx.prefix}tdb`;

  await runImp('net', 'create', lab);

  registerRemoval(ctx.stack, config.keep, () => removeNetworkIfPresent(ctx.client, lab));

  await runImp('net', 'create', ops);

  registerRemoval(ctx.stack, config.keep, () => removeNetworkIfPresent(ctx.client, ops));

  await runImp(
    'new',
    web,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--net',
    lab,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, web));

  await runImp('new', db, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, db));

  await waitForExec(web);
  await waitForExec(db);
  await holdImp(web);
  await holdImp(db);

  const webRow = await requireImp(web);

  const webIp = webRow.ip;

  await runImp('net', 'join', lab, db);
  await runImp('net', 'join', ops, db);
  await runImp('net', 'join', ops, web);
  await runImp('net', 'rm', lab);

  const stillReached = await tryImp(['exec', db, '--', 'ping', '-c', '1', '-W', '2', webIp]);
  const listed = await runImp('net', 'ls', '--json');

  await runImp('net', 'rm', ops);

  const parted = await tryImp(['exec', db, '--', 'ping', '-c', '1', '-W', '2', webIp]);

  expect(stillReached.exitCode).toBe(0);
  expect(JSON.parse(listed)).toMatchObject([{ name: ops, imps: [db, web] }]);
  expect(parted.exitCode).not.toBe(0);
});
