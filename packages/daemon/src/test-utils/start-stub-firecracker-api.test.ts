import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { startStubFirecrackerApi } from './start-stub-firecracker-api';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-api-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { socket: join(dir, 'api.sock') };
}

test('it answers a GET it has no answer for with 200 and a JSON object, as Firecracker does', async () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket);

  const response = await fetch('http://localhost/machine-config', { unix: ctx.socket });
  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(body).toStrictEqual({});
});

test('it answers a PUT it has no answer for with 204 and no body', async () => {
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

test('it never answers when wedged', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket, { isWedged: true });
  const response = fetch('http://localhost/vm', { method: 'PATCH', unix: ctx.socket });

  // runs after the stand-in's own stop, which cuts the request it still holds
  onTestFinished(() => {
    expect(response).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  await waitFor(() => {
    expect(api.calls).toHaveLength(1);
  });

  expect(Bun.peek.status(response)).toBe('pending');
});

test('it stops when the test ends', () => {
  // an abstract socket has no file, so no temp dir's removal can hide the
  // stop; a name already bound refuses the listen
  const socket = `\0imp-fc-api-${crypto.randomUUID()}`;

  startStubFirecrackerApi(socket);

  // runs after the stand-in's own stop
  onTestFinished(() => {
    expect(fetch('http://localhost/version', { unix: socket })).rejects.toMatchObject({
      code: 'FailedToOpenSocket',
    });
  });
});
