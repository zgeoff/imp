import { expect, test } from 'bun:test';
import * as z from 'zod';
import { readRejection } from '../read-rejection';
import { createServicesApi } from './services-api';
import type { TailnetService } from './services-api';

const ServiceBodySchema = z.object({
  name: z.string(),
  comment: z.string(),
  ports: z.array(z.string()),
  tags: z.array(z.string()),
});

const SECRET = 'tskey-client-kExample-SECRETVALUE';

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

// a fake Tailscale API: an OAuth token endpoint and a services store
function startFakeApi() {
  const seen: SeenRequest[] = [];

  const services = new Map<string, TailnetService>();

  const state = { tokens: 0, failNext: 0 };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const url = new URL(request.url);

      const body = await request.text();

      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        body,
      });

      if (url.pathname === '/api/v2/oauth/token') {
        state.tokens += 1;

        return Response.json({ access_token: `token-${String(state.tokens)}`, expires_in: 3600 });
      }

      if (state.failNext > 0) {
        const status = state.failNext;

        state.failNext = 0;

        return Response.json({ message: 'name already in use by a machine' }, { status });
      }

      const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');

      if (url.pathname === '/api/v2/tailnet/-/services') {
        return Response.json({ vipServices: [...services.values()] });
      }

      const found = services.get(name);

      if (request.method === 'PUT') {
        services.set(name, ServiceBodySchema.parse(JSON.parse(body)));

        return Response.json(services.get(name));
      }

      if (found === undefined) {
        return Response.json({ message: 'not found' }, { status: 404 });
      }

      if (request.method === 'DELETE') {
        services.delete(name);

        return new Response(null);
      }

      return Response.json(found);
    },
  });

  return {
    seen,
    services,
    state,
    apiUrl: `http://127.0.0.1:${String(server.port)}/api/v2`,
    [Symbol.dispose]: () => {
      void server.stop(true);
    },
  };
}

function setupApi() {
  const fake = startFakeApi();
  const clock = { now: 0 };

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: SECRET }),
    apiUrl: fake.apiUrl,
    now: () => clock.now,
  });

  return { api, fake, clock, [Symbol.dispose]: fake[Symbol.dispose] };
}

test('it asks for the services scope only, and keeps the token until near its end', async () => {
  using ctx = setupApi();

  await ctx.api.listServices();
  await ctx.api.listServices();

  const form = new URLSearchParams(ctx.fake.seen[0]?.body ?? '');

  expect(form.get('grant_type')).toBe('client_credentials');
  expect(form.get('scope')).toBe('services');
  expect(ctx.fake.state.tokens).toBe(1);
  expect(ctx.fake.seen.at(-1)?.authorization).toBe('Bearer token-1');

  ctx.clock.now = 3_600_000 - 30_000;

  await ctx.api.listServices();

  expect(ctx.fake.state.tokens).toBe(2);
});

test('it writes, reads and deletes a service by name', async () => {
  using ctx = setupApi();

  const missing = await ctx.api.readService('svc:box');

  await ctx.api.writeService({
    name: 'svc:box',
    comment: 'imp host abc',
    ports: ['tcp:80', 'tcp:443'],
    tags: ['tag:imp-svc'],
  });

  const written = await ctx.api.readService('svc:box');

  await ctx.api.deleteService('svc:box');
  await ctx.api.deleteService('svc:box');

  expect(missing).toBeNull();

  expect(written).toEqual({
    name: 'svc:box',
    comment: 'imp host abc',
    ports: ['tcp:80', 'tcp:443'],
    tags: ['tag:imp-svc'],
  });

  expect(ctx.fake.services.size).toBe(0);

  expect(ctx.fake.seen.map((request) => `${request.method} ${request.path}`)).toContain(
    'PUT /api/v2/tailnet/-/services/svc%3Abox',
  );
});

test('an API error carries Tailscale’s message and no secret or token', async () => {
  using ctx = setupApi();

  ctx.fake.state.failNext = 400;

  const error = await readRejection(
    ctx.api.writeService({ name: 'svc:box', comment: '', ports: [], tags: [] }),
  );

  expect(String(error)).toContain('400 name already in use by a machine');
  expect(String(error)).not.toContain(SECRET);
  expect(String(error)).not.toContain('token-1');
});
