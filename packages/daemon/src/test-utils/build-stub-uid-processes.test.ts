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

test('it records each cgroup kill', () => {
  const stub = buildStubUidProcesses();

  stub.deps.killCgroup('i1');
  stub.deps.killCgroup('i2');

  expect(stub.cgroupKills).toStrictEqual(['i1', 'i2']);
});
