import { expect, test } from 'bun:test';
import { buildStubIpCommand } from './build-stub-ip-command';

test('it succeeds silently for a change it has no failure for', async () => {
  const ip = buildStubIpCommand();

  const result = await ip.run(['ip', 'link', 'set', 'imp1', 'up']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it exits 2 with the stderr of the failure whose prefix the argv starts with', async () => {
  const ip = buildStubIpCommand({ failures: { 'ip tuntap': 'Operation not permitted' } });

  const result = await ip.run(['ip', 'tuntap', 'add', 'imp1', 'mode', 'tap']);

  expect(result).toStrictEqual({ exitCode: 2, stdout: '', stderr: 'Operation not permitted\n' });
});

test('it leaves a call whose argv does not start with the failure prefix alone', async () => {
  const ip = buildStubIpCommand({ failures: { 'ip tuntap': 'Operation not permitted' } });

  const result = await ip.run(['ip', 'link', 'del', 'imp1']);

  expect(result.exitCode).toBe(0);
});

test('it reads a sysctl key it was given', async () => {
  const ip = buildStubIpCommand({ sysctls: { 'net.ipv6.conf.imp1.accept_ra': '0' } });

  const result = await ip.run(['sysctl', '-n', 'net.ipv6.conf.imp1.accept_ra']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '0\n', stderr: '' });
});

test('it reads 1 for a sysctl key it was not given', async () => {
  const ip = buildStubIpCommand();

  const result = await ip.run(['sysctl', '-n', 'net.ipv6.conf.imp1.accept_ra']);

  expect(result.stdout).toBe('1\n');
});

test('it prints the output given for a whole argv', async () => {
  const ip = buildStubIpCommand({
    outputs: { 'ip -4 route show default': 'default via 172.17.0.1 dev eth0\n' },
  });

  const stdout = await ip.runChecked(['ip', '-4', 'route', 'show', 'default']);

  expect(stdout).toBe('default via 172.17.0.1 dev eth0\n');
});

test('it throws the stderr from runChecked on a failure', () => {
  const ip = buildStubIpCommand({ failures: { 'ip -4 route': 'Cannot open netlink socket' } });

  expect(ip.runChecked(['ip', '-4', 'route', 'show'])).rejects.toThrowWithMessage(
    Error,
    'ip -4 route show exited 2: Cannot open netlink socket',
  );
});

test('it records every argv in order', async () => {
  const ip = buildStubIpCommand();

  await ip.run(['ip', 'link', 'del', 'imp1']);
  await ip.runChecked(['sysctl', '-n', 'net.ipv6.conf.imp1.accept_ra']);

  expect(ip.calls).toStrictEqual(['ip link del imp1', 'sysctl -n net.ipv6.conf.imp1.accept_ra']);
});
