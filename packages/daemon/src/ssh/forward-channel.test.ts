import { expect, test } from 'bun:test';
import { resolveSocketTarget, resolveTcpTarget } from './forward-channel';

test.each([
  ['localhost', '127.0.0.1:8080'],
  ['LOCALHOST', '127.0.0.1:8080'],
  ['127.0.0.1', '127.0.0.1:8080'],
  ['::1', '[::1]:8080'],
])('it dials a TCP forward to %s at %s in the guest', (host, address) => {
  expect(resolveTcpTarget(host, 8080)).toStrictEqual({ network: 'tcp', address });
});

test.each(['10.66.0.1', 'example.com', '0.0.0.0', '10.66.0.6'])(
  'it refuses a TCP forward to %s, which is not the guest’s loopback',
  (host) => {
    expect(resolveTcpTarget(host, 22)).toBeNull();
  },
);

test.each([0, 65_536, 1.5])('it refuses a TCP forward to port %d', (port) => {
  expect(resolveTcpTarget('localhost', port)).toBeNull();
});

test('it dials a streamlocal forward at its absolute path', () => {
  expect(resolveSocketTarget('/run/app.sock')).toStrictEqual({
    network: 'unix',
    address: '/run/app.sock',
  });
});

test('it dials a relative streamlocal path from the root', () => {
  expect(resolveSocketTarget('tmp/app.sock')).toStrictEqual({
    network: 'unix',
    address: '/tmp/app.sock',
  });
});

test.each([
  '/run/imp/ssh-agent/ab/agent.sock',
  '/run/./imp/ssh-agent/ab/agent.sock',
  '/tmp/../run/imp/x.sock',
  '//run/imp/x.sock',
  'run/imp/x.sock',
])('it refuses a streamlocal forward to %s, under impd’s /run/imp', (path) => {
  expect(resolveSocketTarget(path)).toBeNull();
});
