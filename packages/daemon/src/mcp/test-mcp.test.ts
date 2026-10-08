import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from '@imp/test-utils/run-child-tests';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'test-mcp-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir, testMcpPath: JSON.stringify(join(import.meta.dir, 'test-mcp.ts')) };
}

test('#setupMcpTest stops impd and removes its data dir when the test finishes', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, test } from 'bun:test';",
      "import { existsSync } from 'node:fs';",
      `import { setupMcpTest } from ${ctx.testMcpPath};`,
      "const left = { url: '', dataDir: '' };",
      "test('it sets up', async () => { const mcp = await setupMcpTest(); left.url = mcp.url; left.dataDir = mcp.dataDir; });",
      "test('it finds the data dir gone', () => { expect(existsSync(left.dataDir)).toBeFalse(); });",
      "test('it finds the server stopped', () => { expect(fetch(left.url)).rejects.toThrow(); });",
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 3 pass');
});

test('#setupMcpTest removes its data dir when a setup step throws', async () => {
  const ctx = await setupTest();

  // the child's temp dir is ctx.dir: the harness's data dir is made there
  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, test } from 'bun:test';",
      "import { readdirSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      `import { setupMcpTest } from ${ctx.testMcpPath};`,
      "test('it fails to set up', () => { expect(setupMcpTest({ env: { IMP_SUBNET: 'nope' } })).rejects.toThrow(); });",
      "test('it finds no data dir left', () => { expect(readdirSync(tmpdir()).filter((name) => name.startsWith('impd-test-'))).toStrictEqual([]); });",
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});

test('#setupMcpTest lets the test end release it again after an explicit release', async () => {
  const ctx = await setupTest();

  // a second release that threw would fail the child's test
  const run = runChildTests(
    ctx.dir,
    [
      "import { test } from 'bun:test';",
      `import { setupMcpTest } from ${ctx.testMcpPath};`,
      "test('it releases early', async () => { await (await setupMcpTest())[Symbol.asyncDispose](); });",
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 1 pass');
});

test('#setupMcpTest closes the MCP server, then impd’s, then the database when the test finishes', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, test } from 'bun:test';",
      `import { setupMcpTest } from ${ctx.testMcpPath};`,
      'const logs: string[] = [];',
      "test('it sets up', async () => { await setupMcpTest({ onLog: (line) => { logs.push(line); } }); });",
      "test('it saw the releases in order', () => {",
      "  expect(logs.filter((line) => line.startsWith('test harness: '))).toStrictEqual([",
      "    'test harness: MCP server closed',",
      "    'test harness: server stopped',",
      "    'test harness: database closed',",
      '  ]);',
      '});',
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});
