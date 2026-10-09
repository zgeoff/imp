import { faker } from '@faker-js/faker';
import { Collection } from '@msw/data';
import { HttpResponse, http } from 'msw';
import * as z from 'zod';
import type { CloudflareRecord, CloudflareZone } from '../https/dns/cloudflare-provider';

// Cloudflare's v4 API, where impd's provider sends every call
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

// a list's page size when none is asked for, as Cloudflare's docs give it
const DEFAULT_PER_PAGE = 100;

function buildCloudflareId(): string {
  return faker.string.hexadecimal({ length: 32, casing: 'lower', prefix: '' });
}

const ZoneSchema = z.object({
  id: z.string().default(buildCloudflareId),
  name: z.string().default(() => faker.internet.domainName()),
  name_servers: z
    .array(z.string())
    .default(() => [
      `${faker.word.noun()}.ns.cloudflare.com`,
      `${faker.word.noun()}.ns.cloudflare.com`,
    ]),
});

const RecordSchema = z.object({
  id: z.string().default(buildCloudflareId),
  zone_id: z.string().default(buildCloudflareId),

  // the record's kind gives the rest their meaning: an A record by default
  type: z.string().default('A'),
  name: z.string().default(() => faker.internet.domainName()),
  content: z.string().default(() => faker.internet.ipv4()),
  ttl: z.number().default(1),
  proxied: z.boolean().default(false),

  // Cloudflare answers null for a record made without one
  comment: z.string().nullable().default(null),
});

type StubRecord = z.output<typeof RecordSchema>;

// what a create or an overwrite sends; Cloudflare refuses one without these
const RecordBodySchema = z.object({
  type: z.string(),
  name: z.string(),
  content: z.string(),
  ttl: z.number().optional(),
  proxied: z.boolean().optional(),
  comment: z.string().optional(),
});

// one call as the API received it
interface StubCloudflareRequest {
  readonly method: string;

  // after /client/v4, with the query as sent
  readonly path: string;

  // the bearer token it came with
  readonly token: string;
}

interface StubCloudflareOptions {
  // the tokens it accepts; any other gets the 403 Cloudflare sends
  readonly tokens: readonly string[];

  // the most records one page holds, below what a list asks for; Cloudflare
  // itself serves up to what was asked
  readonly maxPerPage?: number;

  // false leaves result_info off a list's answer
  readonly hasResultInfo?: boolean;
}

interface ApiError {
  readonly code: number;
  readonly message: string;
}

// Cloudflare's envelope around every answer
function buildEnvelope(result: unknown, resultInfo?: unknown): Record<string, unknown> {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo !== undefined && { result_info: resultInfo }),
  };
}

function buildFailure(status: number, error: ApiError): Response {
  return HttpResponse.json(
    { success: false, errors: [error], messages: [], result: null },
    { status },
  );
}

function buildMissingZone(zoneId: string): Response {
  return buildFailure(404, { code: 7003, message: `Could not route to /zones/${zoneId}` });
}

function buildMissingRecord(): Response {
  return buildFailure(404, { code: 81_044, message: 'Record does not exist.' });
}

function buildInvalidRecord(): Response {
  return buildFailure(400, { code: 9005, message: 'Content for A record is invalid.' });
}

// a record in the fields Cloudflare answers and impd reads
function toAnswer(record: StubRecord): CloudflareRecord {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    content: record.content,
    proxied: record.proxied,
    comment: record.comment,
  };
}

async function readRecordBody(request: Request) {
  const json: unknown = await request.json().catch(() => null);

  return RecordBodySchema.safeParse(json);
}

// Cloudflare's v4 zones and DNS records as MSW handlers over collections:
// records listed by type, name or suffix and paged, made, overwritten and
// deleted. An unknown token gets Cloudflare's 403, a missing record its 404.
export function buildStubCloudflareApi(options: Readonly<StubCloudflareOptions>) {
  const zones = new Collection({ schema: ZoneSchema });
  const records = new Collection({ schema: RecordSchema });
  const tokens = new Set(options.tokens);

  const requests: StubCloudflareRequest[] = [];
  const maxPerPage = options.maxPerPage ?? Number.MAX_SAFE_INTEGER;
  const hasResultInfo = options.hasResultInfo ?? true;

  // records the call; the token's refusal, or null when the call may go on
  const checkToken = (request: Request): Response | null => {
    const url = new URL(request.url);

    const token = request.headers.get('authorization')?.replace(/^Bearer /v, '') ?? '';

    requests.push({
      method: request.method,
      path: `${url.pathname.replace('/client/v4', '')}${url.search}`,
      token,
    });

    if (!tokens.has(token)) {
      return buildFailure(403, { code: 9109, message: 'Invalid access token' });
    }

    return null;
  };

  const hasZone = (zoneId: string): boolean =>
    zones.findFirst((query) => query.where({ id: zoneId })) !== undefined;

  const handlers = [
    http.get(`${CLOUDFLARE_API}/zones`, (info) => {
      const refusal = checkToken(info.request);

      if (refusal !== null) {
        return refusal;
      }

      const name = new URL(info.request.url).searchParams.get('name');

      const found = zones
        .findMany()
        .filter((zone) => name === null || zone.name === name)
        .map((zone): CloudflareZone => ({
          id: zone.id,
          name: zone.name,
          name_servers: [...zone.name_servers],
        }));

      return HttpResponse.json(
        buildEnvelope(found, { page: 1, per_page: 20, count: found.length, total_pages: 1 }),
      );
    }),
    http.get(`${CLOUDFLARE_API}/zones/:zoneId/dns_records`, (info) => {
      const refusal = checkToken(info.request);

      if (refusal !== null) {
        return refusal;
      }

      const zoneId = String(info.params['zoneId']);

      if (!hasZone(zoneId)) {
        return buildMissingZone(zoneId);
      }

      const search = new URL(info.request.url).searchParams;

      const type = search.get('type');
      const name = search.get('name');
      const suffix = search.get('name.endswith');
      const asked = Number(search.get('per_page') ?? DEFAULT_PER_PAGE);
      const perPage = Math.min(asked, maxPerPage);
      const page = Number(search.get('page') ?? 1);

      const found = records
        .findMany((query) => query.where({ zone_id: zoneId }))
        .filter(
          (record) =>
            (type === null || record.type === type) &&
            (name === null || record.name === name) &&
            (suffix === null || record.name.endsWith(suffix)),
        );

      const pageRecords = found
        .slice((page - 1) * perPage, page * perPage)
        .map((record) => toAnswer(record));

      const resultInfo = {
        page,
        per_page: perPage,
        count: pageRecords.length,
        total_count: found.length,
        total_pages: Math.ceil(found.length / perPage),
      };

      const answered = hasResultInfo ? resultInfo : undefined;

      return HttpResponse.json(buildEnvelope(pageRecords, answered));
    }),
    http.post(`${CLOUDFLARE_API}/zones/:zoneId/dns_records`, async (info) => {
      const refusal = checkToken(info.request);

      if (refusal !== null) {
        return refusal;
      }

      const zoneId = String(info.params['zoneId']);

      if (!hasZone(zoneId)) {
        return buildMissingZone(zoneId);
      }

      const body = await readRecordBody(info.request);

      if (!body.success) {
        return buildInvalidRecord();
      }

      const created = await records.create({ zone_id: zoneId, ...body.data });

      return HttpResponse.json(buildEnvelope(toAnswer(created)));
    }),
    http.put(`${CLOUDFLARE_API}/zones/:zoneId/dns_records/:recordId`, async (info) => {
      const refusal = checkToken(info.request);

      if (refusal !== null) {
        return refusal;
      }

      const where = { zone_id: String(info.params['zoneId']), id: String(info.params['recordId']) };

      if (records.findFirst((query) => query.where(where)) === undefined) {
        return buildMissingRecord();
      }

      const body = await readRecordBody(info.request);

      if (!body.success) {
        return buildInvalidRecord();
      }

      const replacement = body.data;

      const updated = await records.update((query) => query.where(where), {
        data: (record) => {
          record.type = replacement.type;
          record.name = replacement.name;
          record.content = replacement.content;
          record.ttl = replacement.ttl ?? 1;
          record.proxied = replacement.proxied ?? false;
          record.comment = replacement.comment ?? null;
        },
        strict: true,
      });

      return HttpResponse.json(buildEnvelope(toAnswer(updated)));
    }),
    http.delete(`${CLOUDFLARE_API}/zones/:zoneId/dns_records/:recordId`, (info) => {
      const refusal = checkToken(info.request);

      if (refusal !== null) {
        return refusal;
      }

      const where = { zone_id: String(info.params['zoneId']), id: String(info.params['recordId']) };
      const deleted = records.delete((query) => query.where(where));

      if (deleted === undefined) {
        return buildMissingRecord();
      }

      return HttpResponse.json(buildEnvelope({ id: deleted.id }));
    }),
  ];

  return {
    handlers,
    zones,
    records,
    tokens,
    requests,

    // every record as plain data, in the order they were made
    readRecords: (): StubRecord[] => records.all().map((record) => RecordSchema.parse(record)),
  };
}
