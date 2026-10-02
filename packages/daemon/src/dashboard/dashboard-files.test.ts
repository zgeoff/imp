import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardFiles } from './dashboard-files';

function setupTest() {
  const parent = mkdtempSync(join(tmpdir(), 'imp-dashboard-'));
  const dir = join(parent, 'dist');

  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>imp</title>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(parent, 'secret'), 'outside');

  const files = createDashboardFiles(dir);

  return {
    serve: (path: string) => files.serve(new Request(`http://imp:7070/ui${path}`)),
    [Symbol.dispose]() {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

test('it serves hashed assets as immutable', async () => {
  using ctx = setupTest();

  const response = ctx.serve('/assets/index-abc123.js');

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

  const body = await response.text();

  expect(body).toBe('console.log(1)');
});

test('it serves the shell for an app route, uncached and unframeable', async () => {
  using ctx = setupTest();

  const response = ctx.serve('/imps/box/console');

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

  const body = await response.text();

  expect(body).toContain('<title>imp</title>');
});

test('it answers 404 for a missing asset instead of the shell', () => {
  using ctx = setupTest();

  expect(ctx.serve('/assets/gone-123.js').status).toBe(404);
});

test('it never serves a file outside the directory', async () => {
  using ctx = setupTest();

  // the URL parser folds a dotted segment away; an encoded slash survives it
  for (const path of ['/%2e%2e/secret', '/assets/%2e%2e/%2e%2e/secret', '/..%2fsecret', '/%00']) {
    const body = await ctx.serve(path).text();

    expect(body).not.toBe('outside');
  }

  expect(ctx.serve('/..%2fsecret').status).toBe(400);
  expect(ctx.serve('/%00').status).toBe(400);
});

test('it says so when impd has no dashboard', async () => {
  const response = createDashboardFiles(null).serve(new Request('http://imp:7070/ui/'));

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toContain('IMP_DASHBOARD_DIR');
});
