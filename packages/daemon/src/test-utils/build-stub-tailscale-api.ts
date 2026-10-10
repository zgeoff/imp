import { faker } from '@faker-js/faker';
import { Collection } from '@msw/data';
import { HttpResponse, http } from 'msw';
import { z } from 'zod';
import type { TailnetService } from '../tailnet-names/services-api';

// where the Tailscale API lives, as services-api calls it by default
const TAILSCALE_API = 'https://api.tailscale.com/api/v2';

// a Tailscale Service as the API stores it; a test that seeds one sets the
// fields it needs
const StubServiceSchema = z.object({
  name: z.string().default(() => `svc:${faker.word.noun().toLowerCase()}`),
  comment: z.string().default(() => faker.lorem.words(3)),
  ports: z.array(z.string()).default(() => ['tcp:80', 'tcp:443']),
  tags: z.array(z.string()).default(() => []),
});

// the body of a PUT: every field a service has, and nothing filled in
const PutServiceSchema = z.strictObject({
  name: z.string(),
  comment: z.string(),
  ports: z.array(z.string()),
  tags: z.array(z.string()),
});

// an access token the token endpoint handed out, with its granted scopes
// joined by spaces
const StubTokenSchema = z.object({
  value: z.string().default(() => `tskey-api-${faker.string.alphanumeric(24)}`),
  scope: z.string(),
});

// one request as the API got it
interface StubTailscaleRequest {
  readonly method: string;

  // the path under /api/v2, as sent
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

interface StubTailscaleApiOptions {
  // the one OAuth client the tailnet knows, and the scopes it was granted
  // (`services` by default)
  readonly client: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly scopes?: readonly string[];
  };
}

// The Tailscale API's OAuth token endpoint and Services routes as MSW
// handlers over @msw/data collections: 401 without a live token it issued,
// 403 past the token's scope, 400 for a PUT that is not a whole service.
export function buildStubTailscaleApi(options: Readonly<StubTailscaleApiOptions>) {
  const services = new Collection({ schema: StubServiceSchema });
  const tokens = new Collection({ schema: StubTokenSchema });

  const granted = options.client.scopes ?? ['services'];
  const requests: StubTailscaleRequest[] = [];

  // every request lands in `requests`, in order, before it is answered
  const readRecordedBody = async (request: Request): Promise<string> => {
    const body = await request.text();

    requests.push({
      method: request.method,
      path: new URL(request.url).pathname.slice(new URL(TAILSCALE_API).pathname.length),
      authorization: request.headers.get('authorization'),
      body,
    });

    return body;
  };

  // the scopes of the bearer token, or null for none this API issued
  const readTokenScopes = (request: Request): readonly string[] | null => {
    const header = request.headers.get('authorization') ?? '';
    const bearer = /^Bearer (?<token>.+)$/v.exec(header)?.groups?.['token'];

    const token =
      bearer === undefined
        ? undefined
        : tokens.findFirst((query) => query.where({ value: bearer }));

    return token === undefined ? null : token.scope.split(' ');
  };

  // null when the token may make the call, else the refusal
  const readRefusal = (request: Request): Response | null => {
    const scopes = readTokenScopes(request);

    if (scopes === null) {
      return HttpResponse.json({ message: 'invalid token' }, { status: 401 });
    }

    const reaching =
      request.method === 'GET'
        ? ['services', 'services:read', 'all', 'all:read']
        : ['services', 'all'];

    return scopes.some((scope) => reaching.includes(scope))
      ? null
      : HttpResponse.json({ message: 'insufficient scope' }, { status: 403 });
  };

  const handlers = [
    http.post(`${TAILSCALE_API}/oauth/token`, async (info) => {
      const body = await readRecordedBody(info.request);

      const form = new URLSearchParams(body);

      if (
        form.get('grant_type') !== 'client_credentials' ||
        form.get('client_id') !== options.client.clientId ||
        form.get('client_secret') !== options.client.clientSecret
      ) {
        return HttpResponse.json({ message: 'invalid client credentials' }, { status: 401 });
      }

      const asked = form.get('scope')?.split(' ') ?? granted;

      if (!asked.every((scope) => granted.includes(scope))) {
        return HttpResponse.json({ message: 'invalid scope' }, { status: 400 });
      }

      const token = await tokens.create({ scope: asked.join(' ') });

      return HttpResponse.json({
        access_token: token.value,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: token.scope,
      });
    }),
    http.get(`${TAILSCALE_API}/tailnet/-/services`, async (info) => {
      await readRecordedBody(info.request);

      const refusal = readRefusal(info.request);

      if (refusal !== null) {
        return refusal;
      }

      return HttpResponse.json({ vipServices: services.all().map((each) => toService(each)) });
    }),
    http.all(`${TAILSCALE_API}/tailnet/-/services/:name`, async (info) => {
      const name = String(info.params['name']);

      const body = await readRecordedBody(info.request);

      const refusal = readRefusal(info.request);

      if (refusal !== null) {
        return refusal;
      }

      const found = services.findFirst((query) => query.where({ name }));

      if (info.request.method === 'PUT') {
        const definition = PutServiceSchema.safeParse(parseJson(body));

        if (!definition.success || definition.data.name !== name) {
          return HttpResponse.json({ message: 'invalid service definition' }, { status: 400 });
        }

        services.delete((query) => query.where({ name }));

        const written = await services.create(definition.data);

        return HttpResponse.json(toService(written));
      }

      if (found === undefined) {
        return HttpResponse.json({ message: 'not found' }, { status: 404 });
      }

      if (info.request.method === 'DELETE') {
        services.delete((query) => query.where({ name }));

        return new HttpResponse(null, { status: 200 });
      }

      return HttpResponse.json(toService(found));
    }),
  ];

  return {
    handlers,
    services,
    requests: requests as readonly StubTailscaleRequest[],

    // every access token handed out so far, in order
    readIssuedTokens: (): readonly string[] => tokens.all().map((token) => token.value),

    // every token handed out so far stops working, as an expired one does
    revokeTokens: (): void => {
      tokens.clear();
    },
  };
}

// a body's JSON, or undefined for one that is not JSON
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// the fields the API sends, without the collection's own record metadata
function toService(stored: Required<TailnetService>): TailnetService {
  return { name: stored.name, comment: stored.comment, ports: stored.ports, tags: stored.tags };
}
