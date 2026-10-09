import { expect, test } from 'bun:test';
import { buildStubMounts } from './build-stub-mounts';

test('it records each call as its argv joined by spaces', async () => {
  const stub = buildStubMounts();

  await stub.run(['mount', '--bind', '/a', '/j/a']);
  await stub.run(['umount', '/j/a']);

  expect(stub.calls).toStrictEqual(['mount --bind /a /j/a', 'umount /j/a']);
});

test('it mounts the target of a bind', async () => {
  const stub = buildStubMounts();

  const result = await stub.run(['mount', '--bind', '/a', '/j/a']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(stub.mounted).toStrictEqual(['/j/a']);
});

test('it mounts the target of a recursive bind with options', async () => {
  const stub = buildStubMounts();

  await stub.run(['mount', '--rbind', '-o', 'nosuid=recursive', '/a', '/j/a']);

  expect(stub.mounted).toStrictEqual(['/j/a']);
});

test('it mounts nothing for a propagation change or a remount', async () => {
  const stub = buildStubMounts();

  await stub.run(['mount', '--make-private', '/j']);
  await stub.run(['mount', '-o', 'remount,bind,ro', '/j/a']);

  expect(stub.mounted).toStrictEqual([]);
});

test('it reads the table as /proc/self/mounts lines with spaces escaped', () => {
  const stub = buildStubMounts();

  stub.addMount('/j/root');
  stub.addMount('/j/root/my dir');

  expect(stub.readMounts().split('\n')).toStrictEqual([
    'src /j/root ext4 rw 0 0',
    String.raw`src /j/root/my\040dir ext4 rw 0 0`,
  ]);
});

test('it unmounts a mounted target', async () => {
  const stub = buildStubMounts();

  stub.addMount('/j/a');

  const result = await stub.run(['umount', '/j/a']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(stub.mounted).toStrictEqual([]);
});

test('it refuses to unmount a target that is not mounted', async () => {
  const stub = buildStubMounts();

  const result = await stub.run(['umount', '/j/a']);

  expect(result).toStrictEqual({
    exitCode: 32,
    stdout: '',
    stderr: 'umount: /j/a: not mounted.\n',
  });
});

test('it refuses a plain umount of a busy target and keeps it mounted', async () => {
  const stub = buildStubMounts();

  stub.addMount('/j/a');
  stub.refusePlainUmount('/j/a');

  const result = await stub.run(['umount', '/j/a']);

  expect(result).toStrictEqual({
    exitCode: 32,
    stdout: '',
    stderr: 'umount: /j/a: target is busy.\n',
  });

  expect(stub.mounted).toStrictEqual(['/j/a']);
});

test('it detaches a busy target on a lazy umount', async () => {
  const stub = buildStubMounts();

  stub.addMount('/j/a');
  stub.refusePlainUmount('/j/a');

  const result = await stub.run(['umount', '--lazy', '/j/a']);

  expect(result.exitCode).toBe(0);
  expect(stub.mounted).toStrictEqual([]);
});

test('it refuses a lazy umount of a stuck target', async () => {
  const stub = buildStubMounts();

  stub.addMount('/j/a');
  stub.refuseUmount('/j/a');

  const result = await stub.run(['umount', '--lazy', '/j/a']);

  expect(result.exitCode).toBe(32);
  expect(stub.mounted).toStrictEqual(['/j/a']);
});

test('it reports a kept target unmounted and keeps it in the table', async () => {
  const stub = buildStubMounts();

  stub.addMount('/j/a');
  stub.keepAfterUmount('/j/a');

  const result = await stub.run(['umount', '/j/a']);

  expect(result.exitCode).toBe(0);
  expect(stub.mounted).toStrictEqual(['/j/a']);
});

test('it fails a mount onto a failing target with its stderr and mounts nothing', async () => {
  const stub = buildStubMounts();

  stub.failMount('/j/a', 'mount: /j/a: permission denied.\n');

  const result = await stub.run(['mount', '--bind', '/a', '/j/a']);

  expect(result).toStrictEqual({
    exitCode: 32,
    stdout: '',
    stderr: 'mount: /j/a: permission denied.\n',
  });

  expect(stub.mounted).toStrictEqual([]);
});
