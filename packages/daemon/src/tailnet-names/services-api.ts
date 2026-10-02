import * as z from 'zod';
import type { OAuthCredential } from './oauth-credential';

const TAILSCALE_API = 'https://api.tailscale.com/api/v2';

// a token's last minute is not worth a request that may outlast it
const TOKEN_MARGIN_MS = 60_000;

const ServiceSchema = z
  .object({
    name: z.string(),
    comment: z.string().optional(),
    ports: z.array(z.string()).readonly().optional(),
    tags: z.array(z.string()).readonly().nullable().optional(),
  })
  .readonly();

export type TailnetService = z.infer<typeof ServiceSchema>;

const ServiceListSchema = z.object({ vipServices: z.array(ServiceSchema).nullable().optional() });
const TokenSchema = z.object({ access_token: z.string(), expires_in: z.number().positive() });
const ErrorSchema = z.object({ message: z.string() });

// what the definition of one imp's service says
export interface ServiceDefinition {
  readonly name: string;
  readonly comment: string;
  readonly ports: readonly string[];
  readonly tags: readonly string[];
}

// The Services part of the Tailscale API, as the OAuth client: its
// `services` scope reaches every service on the tailnet, so the caller
// decides which ones are this host's.
export interface ServicesApi {
  readonly listServices: () => Promise<readonly TailnetService[]>;

  // null when no service has the name
  readonly readService: (name: string) => Promise<TailnetService | null>;
  readonly writeService: (definition: ServiceDefinition) => Promise<void>;

  // a service that is already gone counts as deleted
  readonly deleteService: (name: string) => Promise<void>;
}

class TailscaleApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);

    this.name = 'TailscaleApiError';
    this.status = status;
  }
}

interface ServicesApiOptions {
  // read on each new token, so a rotated secret is picked up
  readonly readCredential: () => OAuthCredential;
  readonly apiUrl?: string;
  readonly now?: () => number;
}

export function createServicesApi(options: ServicesApiOptions): ServicesApi {
  const base = options.apiUrl ?? TAILSCALE_API;
  const now = options.now ?? Date.now;
  const token: { value: string | null; expiresAt: number } = { value: null, expiresAt: 0 };

  // client credentials, asking for the services scope and nothing more
  const resolveToken = async (): Promise<string> => {
    if (token.value !== null && now() < token.expiresAt - TOKEN_MARGIN_MS) {
      return token.value;
    }

    const credential = options.readCredential();

    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        grant_type: 'client_credentials',
        scope: 'services',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new TailscaleApiError(
        `Tailscale OAuth token: ${String(response.status)} ${readErrorText(text)}`,
        response.status,
      );
    }

    const parsed = TokenSchema.parse(JSON.parse(text));

    token.value = parsed.access_token;
    token.expiresAt = now() + parsed.expires_in * 1000;

    return parsed.access_token;
  };

  const sendRequest = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const bearer = await resolveToken();

    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();

    if (response.status === 401) {
      token.value = null;
    }

    // the method, the path and Tailscale's message only: the token is a header
    if (!response.ok) {
      throw new TailscaleApiError(
        `Tailscale ${method} ${path}: ${String(response.status)} ${readErrorText(text)}`,
        response.status,
      );
    }

    return text === '' ? null : JSON.parse(text);
  };

  return {
    listServices: async () => {
      const result = await sendRequest('GET', '/tailnet/-/services');

      return ServiceListSchema.parse(result).vipServices ?? [];
    },
    readService: async (name) => {
      try {
        const result = await sendRequest('GET', toPath(name));

        return ServiceSchema.parse(result);
      } catch (error) {
        if (error instanceof TailscaleApiError && error.status === 404) {
          return null;
        }

        throw error;
      }
    },
    writeService: async (definition) => {
      await sendRequest('PUT', toPath(definition.name), definition);
    },
    deleteService: async (name) => {
      try {
        await sendRequest('DELETE', toPath(name));
      } catch (error) {
        if (!(error instanceof TailscaleApiError && error.status === 404)) {
          throw error;
        }
      }
    },
  };
}

function toPath(name: string): string {
  return `/tailnet/-/services/${encodeURIComponent(name)}`;
}

function readErrorText(text: string): string {
  try {
    return ErrorSchema.parse(JSON.parse(text)).message;
  } catch {
    return text.slice(0, 200);
  }
}
