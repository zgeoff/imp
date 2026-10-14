import { expect, test } from 'bun:test';
import { buildStubUidProcesses } from './build-stub-uid-processes';

test('it lists no process for a uid that runs none', () => {
  const stub = buildStubUidProcesses();

  expect(stub.deps.listUidPids(900_001)).toStrictEqual([]);
});

test('it lists the processes a uid runs, and only that uid', () => {
  const stub = buildStubUidProcesses();

  stub.start(900_001, 4242);
  stub.start(900_001, 4243);
  stub.start(900_002, 5000);

  expect(stub.deps.listUidPids(900_001)).toStrictEqual([4242, 4243]);
});

test('it ends a killed process and records the kill', () => {
  const stub = buildStubUidProcesses();

  stub.start(900_001, 4242);
  stub.deps.killUidPid(4242, 900_001);

  expect(stub.deps.listUidPids(900_001)).toStrictEqual([]);
  expect(stub.kills).toStrictEqual([{ pid: 4242, uid: 900_001 }]);
});

test('it keeps a process that survives kills running', () => {
  const stub = buildStubUidProcesses();

  stub.start(900_001, 4242);
  stub.surviveKills(4242);
  stub.deps.killUidPid(4242, 900_001);

  expect(stub.deps.listUidPids(900_001)).toStrictEqual([4242]);
});

test('it lists a slow process for the scans its exit takes after the kill, then no more', () => {
  const stub = buildStubUidProcesses();

  stub.start(900_001, 4242);
  stub.exitSlowly(4242, 2);
  stub.deps.killUidPid(4242, 900_001);

  const scans = [
    stub.deps.listUidPids(900_001),
    stub.deps.listUidPids(900_001),
    stub.deps.listUidPids(900_001),
  ];

  expect(scans).toStrictEqual([[4242], [4242], []]);
});

test('it shows a slow process as exiting only once it is killed', () => {
  const stub = buildStubUidProcesses();

  stub.start(900_001, 4242);
  stub.exitSlowly(4242, 2);

  const before = stub.deps.isPidExiting(4242);

  stub.deps.killUidPid(4242, 900_001);

  expect(before).toBeFalse();
  expect(stub.deps.isPidExiting(4242)).toBeTrue();
});

test('it keeps a slow process exiting through a second kill', () => {
  const stub = buildStubUidProcesses();

  stub.start(900_001, 4242);
  stub.exitSlowly(4242, 2);
  stub.deps.killUidPid(4242, 900_001);
  stub.deps.killUidPid(4242, 900_001);

  expect(stub.deps.listUidPids(900_001)).toStrictEqual([4242]);
});

test('it never shows a process that survives kills as exiting', () => {
  const stub = buildStubUidProcesses();

  stub.start(900_001, 4242);
  stub.surviveKills(4242);
  stub.deps.killUidPid(4242, 900_001);

  expect(stub.deps.isPidExiting(4242)).toBeFalse();
});

test('it holds the chosen pause until its release, and passes the ones before it', async () => {
  const stub = buildStubUidProcesses();
  const hold = stub.holdPause(2);
  const ended: string[] = [];

  await stub.deps.wait();

  const second = (async () => {
    await stub.deps.wait();

    ended.push('second');
  })();

  await hold.reached;

  const whileHeld = [...ended];

  hold.release();

  await second;

  expect(whileHeld).toStrictEqual([]);
  expect(ended).toStrictEqual(['second']);
});

test('it reads the uid that owns a chroot', () => {
  const stub = buildStubUidProcesses();

  stub.ownRoot('/data/jail/firecracker/i1/root', 900_001);

  expect(stub.deps.readRootOwner('/data/jail/firecracker/i1/root')).toBe(900_001);
});

test('it reads no owner for a chroot it was not given', () => {
  const stub = buildStubUidProcesses();

  stub.ownRoot('/data/jail/firecracker/i1/root', 900_001);

  expect(stub.deps.readRootOwner('/data/jail/firecracker/i2/root')).toBeUndefined();
});

test('it records each cgroup kill', () => {
  const stub = buildStubUidProcesses();

  stub.deps.killCgroup('i1');
  stub.deps.killCgroup('i2');

  expect(stub.cgroupKills).toStrictEqual(['i1', 'i2']);
});
