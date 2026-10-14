import { expect, test } from 'bun:test';
import { parseServices } from './services';

test('it reads a running service and a stopped one', () => {
  const stdout = JSON.stringify([
    {
      name: 'web',
      state: 'running',
      pid: 211,
      argv: ['busybox', 'httpd', '-f'],
      envKeys: ['GREETING'],
      source: 'api',
      root: true,
      httpPort: 8080,
    },
    {
      name: 'late',
      state: 'stopped',
      pid: null,
      argv: ['sleep'],
      envKeys: [],
      source: 'file',
      root: false,
    },
  ]);

  expect(parseServices(stdout)).toStrictEqual([
    {
      name: 'web',
      state: 'running',
      pid: 211,
      argv: ['busybox', 'httpd', '-f'],
      envKeys: ['GREETING'],
      source: 'api',
      root: true,
    },
    {
      name: 'late',
      state: 'stopped',
      pid: null,
      argv: ['sleep'],
      envKeys: [],
      source: 'file',
      root: false,
    },
  ]);
});

test('it rejects a pid that is not a whole number', () => {
  const stdout = JSON.stringify([
    { name: 'web', state: 'running', pid: 2.5, argv: [], envKeys: [], source: 'api', root: true },
  ]);

  expect(() => parseServices(stdout)).toThrowErrorMatchingInlineSnapshot(`
    "[
      {
        "expected": "int",
        "format": "safeint",
        "code": "invalid_type",
        "path": [
          0,
          "pid"
        ],
        "message": "Invalid input: expected int, received number"
      }
    ]"
  `);
});
