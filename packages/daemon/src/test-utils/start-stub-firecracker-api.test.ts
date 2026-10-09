import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubFirecrackerApi } from './start-stub-firecracker-api';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-api-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { socket: join(dir, 'api.sock') };
}

test('it answers a call it has no answer for with 204 and no body', async () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket);

  const response = await fetch('http://localhost/actions', {
    method: 'PUT',
    unix: ctx.socket,
    body: JSON.stringify({ action_type: 'InstanceStart' }),
  });

  const body = await response.text();

  expect(response.status).toBe(204);
  expect(body).toBe('');
});

test('it records each call with its JSON body', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await fetch('http://localhost/vm', {
    method: 'PATCH',
    unix: ctx.socket,
    body: JSON.stringify({ state: 'Paused' }),
  });

  await fetch('http://localhost/version', { unix: ctx.socket });

  expect(api.calls).toStrictEqual([
    { method: 'PATCH', path: '/vm', body: { state: 'Paused' } },
    { method: 'GET', path: '/version', body: null },
  ]);
});

test('it sends the answer given for a call, a value as JSON', async () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'GET /version': { status: 200, body: { firecracker_version: '1.17.0' } } },
  });

  const response = await fetch('http://localhost/version', { unix: ctx.socket });
  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(body).toStrictEqual({ firecracker_version: '1.17.0' });
});

test('it sends a string answer as it is', async () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'PUT /actions': { status: 400, body: 'not json' } },
  });

  const response = await fetch('http://localhost/actions', { method: 'PUT', unix: ctx.socket });
  const body = await response.text();

  expect(response.status).toBe(400);
  expect(body).toBe('not json');
});

test('it never answers when wedged', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, { isWedged: true });

  expect(
    fetch('http://localhost/vm', {
      method: 'PATCH',
      unix: ctx.socket,
      signal: AbortSignal.timeout(50),
    }),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
});

test('it stops when the test ends', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket);

  onTestFinished(() => {
    expect(existsSync(ctx.socket)).toBeFalse();
  });
});
