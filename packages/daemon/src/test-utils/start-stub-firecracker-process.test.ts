import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { startStubFirecrackerProcess } from './start-stub-firecracker-process';

test('it runs under the name firecracker with the API socket in its command line', async () => {
  const child = await startStubFirecrackerProcess('/run/imp/i1/api.sock');

  const cmdline = readFileSync(`/proc/${String(child.pid)}/cmdline`, 'utf8').split('\0');

  expect(cmdline[0]).toBe('firecracker');
  expect(cmdline).toContain('/run/imp/i1/api.sock');
});

test('it kills the process when the test ends', async () => {
  const child = await startStubFirecrackerProcess('/run/imp/i1/api.sock');

  onTestFinished(async () => {
    await child.exited;

    expect(child.signalCode).toBe('SIGKILL');
  });
});
