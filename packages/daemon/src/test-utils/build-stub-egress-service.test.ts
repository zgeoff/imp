import { expect, test } from 'bun:test';
import { buildMockDnsQuery, buildMockDnsReply } from './build-mock-dns-message';
import { buildMockNetworkMember } from './build-mock-network-member';
import { buildStubEgressService } from './build-stub-egress-service';

test('it gives the verdict listed for a name of a slot that holds an imp', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'admit' } } });

  const verdict = await egress.deps.checkName(1, 'github.com');

  expect(verdict).toBe('admit');
});

test('it refuses a name the slot does not list', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'admit' } } });

  const verdict = await egress.deps.checkName(1, 'example.org');

  expect(verdict).toBe('refuse');
});

test('it gives no verdict for a slot that holds no imp', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'admit' } } });

  const verdict = await egress.deps.checkName(2, 'github.com');

  expect(verdict).toBeNull();
});

test('it forwards a query to an upstream that answers with the records for its name, in any case', async () => {
  const egress = buildStubEgressService({
    upstream: { 'github.com': [{ type: 'A', name: 'github.com', ttl: 60, data: '140.82.112.3' }] },
  });

  const query = buildMockDnsQuery({ name: 'GitHub.com', type: 'A' });

  const reply = await egress.deps.forward(query);

  expect(reply).toStrictEqual(
    buildMockDnsReply(query, {
      answers: [{ type: 'A', name: 'github.com', ttl: 60, data: '140.82.112.3' }],
    }),
  );

  expect(egress.forwarded).toStrictEqual(['GitHub.com']);
});

test('it records each set write', async () => {
  const egress = buildStubEgressService();

  await egress.deps.writeAnswers(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }]);

  expect(egress.admitted).toStrictEqual([
    { slot: 1, names: ['github.com'], answers: [{ address: '140.82.112.3', ttlS: 60 }] },
  ]);
});

test('it answers the network names of its members', () => {
  const egress = buildStubEgressService({
    networks: ['lab'],
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
    ],
  });

  const answer = egress.deps.resolveLocal(1, { name: 'web.lab.internal', type: 'A' });

  expect(answer).toStrictEqual({
    kind: 'records',
    records: [{ type: 'A', name: 'web.lab.internal', ttl: 5, data: '10.66.0.2' }],
  });
});

test('it screens only the addresses it is given', () => {
  const egress = buildStubEgressService({ screened: ['10.0.0.1'] });

  expect(egress.deps.isScreened('10.0.0.1')).toBeTrue();
  expect(egress.deps.isScreened('10.0.0.2')).toBeFalse();
});

test('it moves its clock only when told to', () => {
  const egress = buildStubEgressService();

  egress.advance(1500);

  expect(egress.deps.now()).toBe(1500);
});

test('it records each log line', () => {
  const egress = buildStubEgressService();

  egress.deps.log('impd: egress: example');

  expect(egress.logs).toStrictEqual(['impd: egress: example']);
});
