import * as z from 'zod';

const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

// lowercase labels, at least two, no wildcard: the base that `*.<domain>`
// and the bare domain hang off
const DomainSchema = z
  .string()
  .transform((value) => value.toLowerCase().replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .regex(
        /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/,
        'IMP_DOMAIN must be a domain name such as imp.example.com',
      ),
  );

const PortSchema = z.coerce.number().pipe(z.int().min(1).max(65_535));
const DNS_PROVIDERS = ['cloudflare', 'challtestsrv'] as const;

type DnsProviderKind = (typeof DNS_PROVIDERS)[number];

export const HttpsEnvSchema = z.object({
  IMP_DOMAIN: DomainSchema.optional(),
  IMP_HTTPS_PORT: PortSchema.default(443),
  IMP_HTTP_PORT: PortSchema.default(80),
  IMP_DNS_PROVIDER: z.enum(DNS_PROVIDERS).optional(),
  IMP_DNS_API_TOKEN: z.string().optional(),
  IMP_DNS_API_URL: z.url().optional(),
  IMP_ACME_DIRECTORY: z.url().default(LETS_ENCRYPT_DIRECTORY),
  IMP_ACME_EMAIL: z.email().optional(),
  IMP_ACME_CA_FILE: z.string().optional(),
});

export interface DnsConfig {
  readonly provider: DnsProviderKind;

  // a secret: never logged, never in an error message
  readonly apiToken: string | null;

  // the provider's API; null is the provider's public endpoint
  readonly apiUrl: string | null;
}

export interface HttpsConfig {
  readonly domain: string;
  readonly httpsPort: number;
  readonly httpPort: number;
  readonly dns: DnsConfig;
  readonly acmeDirectory: string;
  readonly acmeEmail: string | null;

  // a PEM bundle the ACME server's own TLS certificate chains to, for a
  // test CA such as Pebble; null trusts the system roots only
  readonly acmeCaFile: string | null;
}

// null when IMP_DOMAIN is unset: no HTTPS, and the per-port URLs are the only
// tailnet URLs
export function parseHttpsConfig(env: z.infer<typeof HttpsEnvSchema>): HttpsConfig | null {
  if (env.IMP_DOMAIN === undefined) {
    return null;
  }

  if (env.IMP_DNS_PROVIDER === undefined) {
    throw new Error(
      `IMP_DOMAIN needs IMP_DNS_PROVIDER (${DNS_PROVIDERS.join(' or ')}) for its certificate`,
    );
  }

  if (env.IMP_DNS_PROVIDER === 'cloudflare' && env.IMP_DNS_API_TOKEN === undefined) {
    throw new Error('IMP_DNS_PROVIDER=cloudflare needs IMP_DNS_API_TOKEN');
  }

  if (env.IMP_DNS_PROVIDER === 'challtestsrv' && env.IMP_DNS_API_URL === undefined) {
    throw new Error('IMP_DNS_PROVIDER=challtestsrv needs IMP_DNS_API_URL, its management API');
  }

  if (env.IMP_HTTPS_PORT === env.IMP_HTTP_PORT) {
    throw new Error('IMP_HTTPS_PORT and IMP_HTTP_PORT must differ');
  }

  return {
    domain: env.IMP_DOMAIN,
    httpsPort: env.IMP_HTTPS_PORT,
    httpPort: env.IMP_HTTP_PORT,
    dns: {
      provider: env.IMP_DNS_PROVIDER,
      apiToken: env.IMP_DNS_API_TOKEN ?? null,
      apiUrl: env.IMP_DNS_API_URL ?? null,
    },
    acmeDirectory: env.IMP_ACME_DIRECTORY,
    acmeEmail: env.IMP_ACME_EMAIL ?? null,
    acmeCaFile: env.IMP_ACME_CA_FILE ?? null,
  };
}
