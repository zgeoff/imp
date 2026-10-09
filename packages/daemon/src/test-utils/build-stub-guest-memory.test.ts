import { expect, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubGuestMemory } from './build-stub-guest-memory';

test('it reports a default guest with nothing plugged', async () => {
  const stub = buildStubGuestMemory();

  stub.addGuest(buildImpPaths('/data', 'dev'));

  const memory = await stub.vms.readGuestMemory(buildImpPaths('/data', 'dev'));

  expect(memory).toStrictEqual({
    pluggedMib: 0,
    requestedMib: 0,
    totalMib: 512,
    availableMib: 212,
  });
});

test('it finds a plug done on the next read', async () => {
  const stub = buildStubGuestMemory();

  stub.addGuest(buildImpPaths('/data', 'dev'));

  await stub.vms.requestPluggedMib(buildImpPaths('/data', 'dev'), 256);

  const memory = await stub.vms.readGuestMemory(buildImpPaths('/data', 'dev'));

  expect(memory.pluggedMib).toBe(256);
});

test('it finds an unplug stopped at the floor', async () => {
  const stub = buildStubGuestMemory();

  stub.addGuest(buildImpPaths('/data', 'dev'), {
    pluggedMib: 1024,
    requestedMib: 1024,
    unplugFloorMib: 768,
  });

  await stub.vms.requestPluggedMib(buildImpPaths('/data', 'dev'), 496);

  const memory = await stub.vms.readGuestMemory(buildImpPaths('/data', 'dev'));

  expect(memory.pluggedMib).toBe(768);
});

test('it leaves a slow guest where it was', async () => {
  const stub = buildStubGuestMemory();

  stub.addGuest(buildImpPaths('/data', 'dev'), { isSlow: true });

  await stub.vms.requestPluggedMib(buildImpPaths('/data', 'dev'), 256);

  const memory = await stub.vms.readGuestMemory(buildImpPaths('/data', 'dev'));

  expect(memory.pluggedMib).toBe(0);
});

test('it records each requested size', async () => {
  const stub = buildStubGuestMemory();

  stub.addGuest(buildImpPaths('/data', 'dev'));

  await stub.vms.requestPluggedMib(buildImpPaths('/data', 'dev'), 256);
  await stub.vms.requestPluggedMib(buildImpPaths('/data', 'dev'), 0);

  expect(stub.requests).toStrictEqual([256, 0]);
});

test('it keeps each guest apart', async () => {
  const stub = buildStubGuestMemory();

  stub.addGuest(buildImpPaths('/data', 'dev'));
  stub.addGuest(buildImpPaths('/data', 'other'), { pluggedMib: 128, requestedMib: 128 });

  await stub.vms.requestPluggedMib(buildImpPaths('/data', 'dev'), 256);

  const memory = await stub.vms.readGuestMemory(buildImpPaths('/data', 'other'));

  expect(memory.pluggedMib).toBe(128);
});

test('it throws for a VM it does not hold', () => {
  const stub = buildStubGuestMemory();

  expect(() => stub.vms.readGuestMemory(buildImpPaths('/data', 'gone'))).toThrowWithMessage(
    Error,
    'no such VM',
  );
});
