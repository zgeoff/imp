import { faker } from '@faker-js/faker';
import { Collection } from '@msw/data';
import { HttpResponse, http } from 'msw';
import { z } from 'zod';
import type { TailnetService } from '../tailnet-names/services-api';

// where the Tailscale API lives, as services-api calls it by default
const TAILSCALE_API = 'https://api.tailscale.com/api/v2';

// a Tailscale Service as the API stores it; a test sets the fields it needs
const StubServiceSchema = z.object({
  name: z.string().default(() => `svc:${faker.word.noun().toLowerCase()}`),
  comment: z.string().default(() => faker.lorem.words(3)),
  ports: z.array(z.string()).default(() => ['tcp:80', 'tcp:443']),
  tags: z.array(z.string()).default(() => []),
});

// an access token the token endpoint handed out
const StubTokenSchema = z.object({
  value: z.string().default(() => `tskey-api-${faker.string.alphanumeric(24)}`),
  scope: z.string().default('services'),
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
  // the one OAuth client the tailnet knows
  readonly client: { readonly clientId: string; readonly clientSecret: string };
}

// The Tailscale API's OAuth token endpoint and Services routes as MSW
// handlers over @msw/data collections. Only the named client gets a token;
// any other route answers 401 without a token it issued and not revoked.
export function buildStubTailscaleApi(options: Readonly<StubTailscaleApiOptions>) {
  const services = new Collection({ schema: StubServiceSchema });
  const tokens = new Collection({ schema: StubTokenSchema });

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

  const isAuthorized = (request: Request): boolean => {
    const header = request.headers.get('authorization') ?? '';
    const bearer = /^Bearer (?<token>.+)$/v.exec(header)?.groups?.['token'];

    return (
      bearer !== undefined &&
      tokens.findFirst((query) => query.where({ value: bearer })) !== undefined
    );
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

      const token = await tokens.create({ scope: form.get('scope') ?? '' });

      return HttpResponse.json({
        access_token: token.value,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: token.scope,
      });
    }),
    http.get(`${TAILSCALE_API}/tailnet/-/services`, async (info) => {
      await readRecordedBody(info.request);

      if (!isAuthorized(info.request)) {
        return buildUnauthorized();
      }

      return HttpResponse.json({ vipServices: services.all().map((each) => toService(each)) });
    }),
    http.all(`${TAILSCALE_API}/tailnet/-/services/:name`, async (info) => {
      const name = String(info.params['name']);

      const body = await readRecordedBody(info.request);

      if (!isAuthorized(info.request)) {
        return buildUnauthorized();
      }

      const found = services.findFirst((query) => query.where({ name }));

      if (info.request.method === 'PUT') {
        const definition = StubServiceSchema.parse(JSON.parse(body));

        services.delete((query) => query.where({ name }));

        const written = await services.create({ ...definition, name });

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

    // every token handed out so far stops working, as an expired one does
    revokeTokens: (): void => {
      tokens.clear();
    },
  };
}

// Tailscale's answer to a missing, expired or revoked token
function buildUnauthorized() {
  return HttpResponse.json({ message: 'invalid token' }, { status: 401 });
}

// the fields the API sends, without the collection's own record metadata
function toService(stored: Required<TailnetService>): TailnetService {
  return { name: stored.name, comment: stored.comment, ports: stored.ports, tags: stored.tags };
}
