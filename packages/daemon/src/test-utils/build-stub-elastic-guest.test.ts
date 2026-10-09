import { expect, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubElasticGuest } from './build-stub-elastic-guest';

test('it reports what the guest holds as Firecracker does', async () => {
  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 1024,
    requestedMib: 1024,
    stepMib: 200,
  });

  const memory = await stub.vm.readGuestMemory();

  expect(memory).toStrictEqual({
    pluggedMib: 1024,
    requestedMib: 1024,
    totalMib: 1536,
    availableMib: 936,
  });
});

test('it records each requested size', async () => {
  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 1024,
    requestedMib: 1024,
    stepMib: 200,
  });

  await stub.vm.requestPluggedMib(buildImpPaths('/data', 'dev'), 496);

  expect(stub.requests).toStrictEqual([496]);
  expect(stub.guest.requestedMib).toBe(496);
});

test('it unplugs one step toward the request on each read', async () => {
  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 1024,
    requestedMib: 496,
    stepMib: 200,
  });

  await stub.vm.readGuestMemory();

  const memory = await stub.vm.readGuestMemory();

  expect(memory.pluggedMib).toBe(624);
});

test('it unplugs no further than the request', async () => {
  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 600,
    requestedMib: 496,
    stepMib: 200,
  });

  const memory = await stub.vm.readGuestMemory();

  expect(memory.pluggedMib).toBe(496);
});

test('it unplugs no further than the floor', async () => {
  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 1024,
    requestedMib: 496,
    stepMib: 200,
    floorMib: 768,
  });

  await stub.vm.readGuestMemory();

  const memory = await stub.vm.readGuestMemory();

  expect(memory.pluggedMib).toBe(768);
});

test('it plugs nothing on a read while the request is above what it holds', async () => {
  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 300,
    requestedMib: 556,
    stepMib: 200,
  });

  const memory = await stub.vm.readGuestMemory();

  expect(memory.pluggedMib).toBe(300);
});
