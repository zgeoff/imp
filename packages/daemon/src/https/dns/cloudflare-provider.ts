import * as z from 'zod';
import type { DnsProvider } from './dns-provider';
import { waitForTxt } from './wait-for-txt';
import type { WaitForTxtOptions } from './wait-for-txt';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

// short, so a stale challenge value is gone soon after a failed attempt
const TXT_TTL_S = 60;
const A_TTL_S = 300;
const ApiErrorSchema = z.object({ code: z.number().optional(), message: z.string() });

const EnvelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(ApiErrorSchema).default([]),
  result: z.unknown().optional(),
});

const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  name_servers: z.array(z.string()),
});

const RecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
});

const ZoneListSchema = z.array(ZoneSchema);
const RecordListSchema = z.array(RecordSchema);

type Zone = z.infer<typeof ZoneSchema>;

interface CloudflareOptions {
  // a token with Zone:Read and DNS:Edit on the zone; never logged
  readonly token: string;
  readonly apiUrl?: string;
  readonly propagation?: WaitForTxtOptions;
}

// Cloudflare's v4 API. Records are DNS only (`proxied: false`): a proxied
// record would send clients to Cloudflare's edge, which cannot reach a
// tailnet address.
export function createCloudflareProvider(options: CloudflareOptions): DnsProvider {
  const base = options.apiUrl ?? CLOUDFLARE_API;

  // by the name asked for, so each name walks the labels once
  const zones = new Map<string, Zone>();

  const sendRequest = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();

    const parsed = EnvelopeSchema.safeParse(parseJsonOrNull(text));

    if (!response.ok || !parsed.success || !parsed.data.success) {
      const reasons = parsed.success
        ? parsed.data.errors.map((error) => error.message).join('; ')
        : 'no Cloudflare answer';

      // the path and Cloudflare's own messages only: the token is a header
      throw new Error(
        `Cloudflare ${method} ${path.split('?')[0] ?? path}: ${String(response.status)} ${reasons}`,
      );
    }

    return parsed.data.result;
  };

  // The zone that holds the name: walk up its labels until one is a zone
  // the token can see, so imp.example.com and imp.example.co.uk both work.
  const findZone = async (fqdn: string): Promise<Zone> => {
    const cached = zones.get(fqdn);

    if (cached !== undefined) {
      return cached;
    }

    const labels = fqdn.split('.');

    // `*.imp.example.com` is a record in a zone, never a zone's own name
    const first = labels[0] === '*' ? 1 : 0;

    for (let index = first; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');

      const result = await sendRequest('GET', `/zones?name=${encodeURIComponent(candidate)}`);

      const found = ZoneListSchema.parse(result);
      const zone = found.find((item) => item.name === candidate);

      if (zone !== undefined) {
        zones.set(fqdn, zone);

        return zone;
      }
    }

    throw new Error(`Cloudflare: no zone this token can see holds ${fqdn}`);
  };

  return {
    addTxt: async (fqdn, value) => {
      const zone = await findZone(fqdn);

      const result = await sendRequest('POST', `/zones/${zone.id}/dns_records`, {
        type: 'TXT',
        name: fqdn,
        content: value,
        ttl: TXT_TTL_S,
      });

      const created = RecordSchema.parse(result);

      return { fqdn, value, id: `${zone.id}/${created.id}` };
    },
    removeTxt: async (record) => {
      await sendRequest('DELETE', `/zones/${record.id.replace('/', '/dns_records/')}`);
    },
    waitForTxt: async (fqdn, values) => {
      const zone = await findZone(fqdn);

      await waitForTxt(zone.name_servers, fqdn, values, options.propagation);
    },
    setA: async (fqdn, ip) => {
      const zone = await findZone(fqdn);

      const query = `type=A&name=${encodeURIComponent(fqdn)}`;

      const result = await sendRequest('GET', `/zones/${zone.id}/dns_records?${query}`);

      const existing = RecordListSchema.parse(result);
      const record = { type: 'A', name: fqdn, content: ip, ttl: A_TTL_S, proxied: false };
      const [current] = existing;

      if (current === undefined) {
        await sendRequest('POST', `/zones/${zone.id}/dns_records`, record);
      } else if (current.content !== ip || current.proxied === true) {
        await sendRequest('PUT', `/zones/${zone.id}/dns_records/${current.id}`, record);
      }
    },
  };
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
