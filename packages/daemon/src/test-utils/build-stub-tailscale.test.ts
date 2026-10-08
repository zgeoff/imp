import { expect, test } from 'bun:test';
import { isTailnetAddress, parseWhois } from '../auth/tailnet-identity';
import { parseTailscaleStatus } from '../net/tailscale-status';
import { buildStubTailscale } from './build-stub-tailscale';

test('it reports a running node with one tailnet address by default', () => {
  const tailscale = buildStubTailscale();

  expect(tailscale.status).toStrictEqual({
    state: 'Running',
    hostname: expect.toBeString(),
    dnsName: `${String(tailscale.status.hostname)}.tail1234.ts.net`,
    ip: expect.toBeString(),
    ips: [String(tailscale.status.ip)],
  });

  expect(isTailnetAddress(String(tailscale.status.ip))).toBeTrue();
});

test('it reports the status a test gives in place of the default', async () => {
  const tailscale = buildStubTailscale({
    status: {
      hostname: 'imp-1',
      dnsName: 'imp-1.tail1234.ts.net',
      ip: '100.64.0.7',
      ips: ['100.64.0.7', 'fd7a:115c:a1e0::7'],
    },
  });

  const status = await tailscale.readTailscale();

  expect(status).toStrictEqual({
    state: 'Running',
    hostname: 'imp-1',
    dnsName: 'imp-1.tail1234.ts.net',
    ip: '100.64.0.7',
    ips: ['100.64.0.7', 'fd7a:115c:a1e0::7'],
  });
});

test('it answers status --json with JSON that tailscale’s status parser reads back', async () => {
  const tailscale = buildStubTailscale({
    status: {
      hostname: 'imp-1',
      dnsName: 'imp-1.tail1234.ts.net',
      ip: '100.64.0.7',
      ips: ['100.64.0.7'],
    },
  });

  const result = await tailscale.run(['tailscale', 'status', '--json']);

  expect(parseTailscaleStatus(result.stdout)).toStrictEqual(tailscale.status);
});

test('it answers whois --json for a user’s node with JSON the whois parser reads back', async () => {
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  const result = await tailscale.run(['tailscale', 'whois', '--json', '100.101.102.103']);

  expect(result.exitCode).toBe(0);

  expect(parseWhois(result.stdout)).toStrictEqual({
    login: 'alice@example.com',
    tags: [],
    node: 'laptop',
    stableId: null,
  });
});

test('it answers whois for a tagged node under tailscale’s placeholder user', async () => {
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.104', {
    node: 'runner',
    login: null,
    tags: ['tag:ci'],
    stableId: 'nRunner1CNTRL',
  });

  const result = await tailscale.run(['tailscale', 'whois', '--json', '100.101.102.104']);

  expect(JSON.parse(result.stdout)).toMatchObject({
    Node: { StableID: 'nRunner1CNTRL', Name: 'runner.tail1234.ts.net.', Tags: ['tag:ci'] },
    UserProfile: { LoginName: 'tagged-devices' },
  });
});

test('it exits 1 for an address no peer holds', async () => {
  const tailscale = buildStubTailscale();

  const result = await tailscale.run(['tailscale', 'whois', '--json', '100.64.9.9']);

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'peer not found\n' });
});

test('it records each address whois was asked about, in order', async () => {
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  await tailscale.run(['tailscale', 'whois', '--json', '100.64.9.9']);
  await tailscale.run(['tailscale', 'whois', '--json', '100.101.102.103']);

  expect(tailscale.asked).toStrictEqual(['100.64.9.9', '100.101.102.103']);
});

test('it rejects a command it does not model', () => {
  const tailscale = buildStubTailscale();

  expect(tailscale.run(['tailscale', 'up'])).rejects.toThrowWithMessage(
    Error,
    'the stub tailscale does not run tailscale up',
  );
});
