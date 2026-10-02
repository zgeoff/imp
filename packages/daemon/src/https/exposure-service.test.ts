import { expect, test } from 'bun:test';
import { loadConfig } from '../config';
import { setupImpTest } from '../imps/test-imps';
import { createExposureService } from './exposure-service';
import type { RecordsStatus } from './https-service';

const PUBLIC_ENV = {
  IMP_DOMAIN: 'imp.example.com',
  IMP_DNS_PROVIDER: 'cloudflare',
  IMP_DNS_API_TOKEN: 'unused',
  IMP_PUBLIC_IP: '203.0.113.7',
};

async function setup(status: RecordsStatus | null) {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'web' });

  const updates: string[] = [];

  const exposure = createExposureService({
    db: ctx.db,
    https: loadConfig(PUBLIC_ENV).https,
    updateRecords: () => {
      updates.push('update');

      return Promise.resolve(status);
    },
  });

  return { ...ctx, exposure, updates };
}

test('an expose whose record write fails says so, and still makes the imp public', async () => {
  await using ctx = await setup({ isOk: false, error: 'Cloudflare 403', at: 0 });

  const result = await ctx.exposure.expose({ name: 'web', auth: 'token' });

  expect(result.warning).toBe(
    'the DNS record for web.imp.example.com is not written yet (Cloudflare 403); impd tries again every 10 minutes',
  );

  expect(result.credential).not.toBeNull();
  expect(ctx.updates).toEqual(['update']);
});

test('an expose and an unexpose each update the records at once', async () => {
  await using ctx = await setup({ isOk: true, error: null, at: 0 });

  const result = await ctx.exposure.expose({ name: 'web', auth: 'none' });
  const imp = await ctx.exposure.unexpose('web');

  expect(result.warning).toBeUndefined();
  expect(imp.publicAuth).toBeNull();
  expect(ctx.updates).toEqual(['update', 'update']);
});
