import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardFiles } from './dashboard-files';

function setupTest() {
  const parent = mkdtempSync(join(tmpdir(), 'imp-dashboard-'));

  onTestFinished(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  const dir = join(parent, 'dist');

  mkdirSync(join(dir, 'assets'), { recursive: true });

  return { parent, dir };
}

test('it serves a hashed asset as immutable', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'index.html'), '<!doctype html><title>imp</title>');
  writeFileSync(join(ctx.dir, 'assets', 'index-abc123.js'), 'console.log(1)');

  const response = createDashboardFiles(ctx.dir).serve(
    new Request('http://imp:7070/ui/assets/index-abc123.js'),
  );

  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(response.headers.get('content-security-policy')).toBeNull();
  expect(body).toBe('console.log(1)');
});

test('it serves the shell for an app route, uncached and unframeable', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = createDashboardFiles(ctx.dir).serve(
    new Request('http://imp:7070/ui/imps/box/console'),
  );

  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('same-origin');
  expect(response.headers.get('content-security-policy')).toInclude("frame-ancestors 'none'");
  expect(body).toBe('<!doctype html><title>imp</title>');
});

test('it answers 404 for a missing asset instead of the shell', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = createDashboardFiles(ctx.dir).serve(
    new Request('http://imp:7070/ui/assets/gone-123.js'),
  );

  const body = await response.text();

  expect(response.status).toBe(404);
  expect(body).toBe('not found\n');
});

// the URL parser folds a dotted segment away, so the shell answers; an encoded
// slash survives it and is refused
test.each([
  ['/ui/%2e%2e/secret', 200, '<!doctype html><title>imp</title>'],
  ['/ui/assets/%2e%2e/%2e%2e/secret', 200, '<!doctype html><title>imp</title>'],
  ['/ui/..%2fsecret', 400, 'bad path\n'],
  ['/ui/%00', 400, 'bad path\n'],
  ['/ui/%E0%A4%A', 400, 'bad path\n'],
])(
  'it never serves a file outside the directory for %s, answering %d',
  async (path, status, expected) => {
    const ctx = setupTest();

    writeFileSync(join(ctx.dir, 'index.html'), '<!doctype html><title>imp</title>');
    writeFileSync(join(ctx.parent, 'secret'), 'outside');

    const response = createDashboardFiles(ctx.dir).serve(new Request(`http://imp:7070${path}`));

    const body = await response.text();

    expect(response.status).toBe(status);
    expect(body).toBe(expected);
  },
);

test('it says so when impd has no dashboard', async () => {
  const response = createDashboardFiles(null).serve(new Request('http://imp:7070/ui/'));

  const body = await response.text();

  expect(response.status).toBe(404);
  expect(body).toBe('the dashboard is not built into this impd (IMP_DASHBOARD_DIR)\n');
});

test('it says so when the dashboard directory holds no shell', async () => {
  const ctx = setupTest();
  const response = createDashboardFiles(ctx.dir).serve(new Request('http://imp:7070/ui/'));

  const body = await response.text();

  expect(response.status).toBe(404);
  expect(body).toBe('the dashboard is not built into this impd (IMP_DASHBOARD_DIR)\n');
});
