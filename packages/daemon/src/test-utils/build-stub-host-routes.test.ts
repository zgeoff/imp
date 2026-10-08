import { expect, test } from 'bun:test';
import { buildStubHostRoutes } from './build-stub-host-routes';

test('it reads no IPv4 networks by default', () => {
  const routes = buildStubHostRoutes();

  expect(routes.deps.readConnected4()).resolves.toStrictEqual([]);
});

test('it reads no IPv6 networks by default', () => {
  const routes = buildStubHostRoutes();

  expect(routes.deps.readConnected6()).resolves.toStrictEqual([]);
});

test('it reads no uplinks by default', () => {
  const routes = buildStubHostRoutes();

  expect(routes.deps.readUplinks()).resolves.toStrictEqual({ ipv4: [], ipv6: [] });
});

test('it reads the networks of each family it is given', async () => {
  const routes = buildStubHostRoutes({
    connected4: ['172.17.0.0/16', '172.17.0.2/32'],
    connected6: ['2001:db8:a::/64'],
  });

  const connected4 = await routes.deps.readConnected4();
  const connected6 = await routes.deps.readConnected6();

  expect(connected4).toStrictEqual(['172.17.0.0/16', '172.17.0.2/32']);
  expect(connected6).toStrictEqual(['2001:db8:a::/64']);
});

test('it reads the uplinks it is given', () => {
  const routes = buildStubHostRoutes({ uplinks: { ipv4: ['eth0'], ipv6: ['eth1'] } });

  expect(routes.deps.readUplinks()).resolves.toStrictEqual({ ipv4: ['eth0'], ipv6: ['eth1'] });
});

test('it rejects each route read with the failure it is given', () => {
  const routes = buildStubHostRoutes({ uplinks: { ipv4: ['eth0'], ipv6: [] } });

  routes.failUplinks('ip -4 route show default exited 1');

  expect(routes.deps.readUplinks()).rejects.toThrow(new Error('ip -4 route show default exited 1'));
});

test('it reads the uplinks again once restored', () => {
  const routes = buildStubHostRoutes({ uplinks: { ipv4: ['eth0'], ipv6: [] } });

  routes.failUplinks('ip -4 route show default exited 1');
  routes.restoreUplinks();

  expect(routes.deps.readUplinks()).resolves.toStrictEqual({ ipv4: ['eth0'], ipv6: [] });
});
