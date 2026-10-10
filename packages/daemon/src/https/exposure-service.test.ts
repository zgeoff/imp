import { expect, mock, test } from 'bun:test';
import { loadConfig } from '../config';
import { findPublicImp } from '../db/exposure';
import { createImage } from '../db/images';
import { createImp, updateImpExposure, updateImpMove } from '../db/imps';
import { buildQueryGate } from '../test-utils/build-query-gate';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createExposureService } from './exposure-service';
import { buildCredentialHash } from './public-auth';

async function setupTest() {
  const database = await createTestDatabase();

  // an imp row needs the image it boots
  const image = await createImage(database.db, {
    name: 'ubuntu',
    ref: 'docker.io/library/ubuntu:24.04',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  return { db: database.db, imageId: image.id };
}

test('#expose refuses when the host has no domain', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({}).https,
    updateRecords: () => Promise.resolve(null),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  expect(exposure.expose({ name: 'web', auth: 'none' })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host',
  });
});

test('#expose refuses when the host has a domain but no public IP', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
    }).https,
    updateRecords: () => Promise.resolve(null),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  expect(exposure.expose({ name: 'web', auth: 'none' })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
});

test('#expose refuses an imp that does not exist', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve(null),
  });

  expect(exposure.expose({ name: 'web', auth: 'none' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'imp web not found',
  });
});

test('#expose refuses an imp that is moving', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve(null),
  });

  const imp = await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  await updateImpMove(ctx.db, imp.id, 'sending');

  expect(exposure.expose({ name: 'web', auth: 'none' })).rejects.toMatchObject({
    code: 'MOVING',
    status: 409,
  });
});

test('#expose refuses an imp a move marks between its read and its write', async () => {
  const ctx = await setupTest();

  const gate = buildQueryGate('imps');

  const exposure = createExposureService({
    db: ctx.db.withPlugin(gate.plugin),
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve(null),
  });

  const imp = await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  gate.arm();

  const exposed = exposure.expose({ name: 'web', auth: 'none' });

  await gate.reached;
  await updateImpMove(ctx.db, imp.id, 'sending');

  gate.release();

  expect(exposed).rejects.toMatchObject({ code: 'MOVING' });
});

test('#expose makes a token imp public with a fresh credential shown once', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve({ isOk: true, error: null, at: 0 }),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  const result = await exposure.expose({ name: 'web', auth: 'token' });

  expect(result).toStrictEqual({
    url: 'https://web.imp.example.com',
    auth: 'token',
    user: null,
    credential: expect.toSatisfy((credential: string) => /^[\w\-]{43}$/v.test(credential)),
  });
});

test('#expose stores only the hash of the credential it shows', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve({ isOk: true, error: null, at: 0 }),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  const result = await exposure.expose({ name: 'web', auth: 'token' });
  const found = await findPublicImp(ctx.db, 'web');

  expect(found?.stored).toStrictEqual({
    auth: 'token',
    user: null,
    hash: buildCredentialHash(result.credential ?? ''),
  });
});

test('#expose gives basic auth the user imp when the request names none', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve({ isOk: true, error: null, at: 0 }),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  const result = await exposure.expose({ name: 'web', auth: 'basic' });

  expect(result.user).toBe('imp');
});

test('#expose gives basic auth the user the request names', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve({ isOk: true, error: null, at: 0 }),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  const result = await exposure.expose({ name: 'web', auth: 'basic', user: 'ann' });

  expect(result.user).toBe('ann');
});

test('#expose makes an imp public with no credential for no auth', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve({ isOk: true, error: null, at: 0 }),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  const result = await exposure.expose({ name: 'web', auth: 'none' });

  expect(result).toStrictEqual({
    url: 'https://web.imp.example.com',
    auth: 'none',
    user: null,
    credential: null,
  });
});

test('#expose updates the records once', async () => {
  const ctx = await setupTest();

  const updateRecords = mock(() => Promise.resolve({ isOk: true, error: null, at: 0 }));

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords,
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  await exposure.expose({ name: 'web', auth: 'none' });

  expect(updateRecords).toHaveBeenCalledOnce();
});

test('#expose warns when the record write fails', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve({ isOk: false, error: 'Cloudflare 403', at: 0 }),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  const result = await exposure.expose({ name: 'web', auth: 'token' });

  expect(result.warning).toBe(
    'the DNS record for web.imp.example.com is not written yet (Cloudflare 403); impd tries again every 10 minutes',
  );
});

test('#expose still makes the imp public when the record write fails', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve({ isOk: false, error: 'Cloudflare 403', at: 0 }),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  await exposure.expose({ name: 'web', auth: 'none' });

  const found = await findPublicImp(ctx.db, 'web');

  expect(found?.stored).toStrictEqual({ auth: 'none', user: null, hash: null });
});

test('#expose names an unknown error when the failed record write gives none', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve({ isOk: false, error: null, at: 0 }),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  const result = await exposure.expose({ name: 'web', auth: 'none' });

  expect(result.warning).toBe(
    'the DNS record for web.imp.example.com is not written yet (unknown error); impd tries again every 10 minutes',
  );
});

test('#expose gives no warning when there is no HTTPS service to write records', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    }).https,
    updateRecords: () => Promise.resolve(null),
  });

  await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  const result = await exposure.expose({ name: 'web', auth: 'none' });

  expect(result.warning).toBeUndefined();
});

test('#unexpose takes the imp off the internet', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({}).https,
    updateRecords: () => Promise.resolve(null),
  });

  const imp = await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  await updateImpExposure(ctx.db, imp.id, { auth: 'none', user: null, hash: null });

  const unexposed = await exposure.unexpose('web');

  expect(unexposed.publicAuth).toBeNull();
});

test('#unexpose updates the records once', async () => {
  const ctx = await setupTest();

  const updateRecords = mock(() => Promise.resolve(null));

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({}).https,
    updateRecords,
  });

  const imp = await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  await updateImpExposure(ctx.db, imp.id, { auth: 'none', user: null, hash: null });

  await exposure.unexpose('web');

  expect(updateRecords).toHaveBeenCalledOnce();
});

test('#unexpose refuses an imp that does not exist', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({}).https,
    updateRecords: () => Promise.resolve(null),
  });

  expect(exposure.unexpose('web')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('#unexpose refuses an imp that is moving', async () => {
  const ctx = await setupTest();

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig({}).https,
    updateRecords: () => Promise.resolve(null),
  });

  const imp = await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  await updateImpMove(ctx.db, imp.id, 'sending');

  expect(exposure.unexpose('web')).rejects.toMatchObject({ code: 'MOVING' });
});

test('#unexpose refuses an imp a move marks between its read and its write', async () => {
  const ctx = await setupTest();

  const gate = buildQueryGate('imps');

  const exposure = createExposureService({
    db: ctx.db.withPlugin(gate.plugin),
    https: loadConfig({}).https,
    updateRecords: () => Promise.resolve(null),
  });

  const imp = await createImp(ctx.db, {
    name: 'web',
    imageId: ctx.imageId,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.2',
  });

  gate.arm();

  const unexposed = exposure.unexpose('web');

  await gate.reached;
  await updateImpMove(ctx.db, imp.id, 'sending');

  gate.release();

  expect(unexposed).rejects.toMatchObject({ code: 'MOVING' });
});
