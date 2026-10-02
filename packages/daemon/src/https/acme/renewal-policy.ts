import type { AttemptState } from './cert-store';

export interface CertificateInfo {
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly names: readonly string[];
}

export type RenewalDecision =
  | { readonly kind: 'keep' }
  | { readonly kind: 'issue'; readonly reason: string }
  | { readonly kind: 'wait'; readonly reason: string; readonly until: number };

// Let's Encrypt allows 5 failed validations per name per hour: the first
// retry waits past that window's start, and each next one twice as long.
const FIRST_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;

// renew once two thirds of the lifetime has passed: day 60 of a 90-day
// certificate, as certbot and Caddy do
const RENEW_AT_FRACTION = 2 / 3;

export function readBackoffMs(failures: number): number {
  return failures === 0 ? 0 : Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

// the names one certificate must hold for the domain
export function listCertificateNames(domain: string): readonly string[] {
  return [domain, `*.${domain}`];
}

interface RenewalInput {
  readonly info: CertificateInfo | null;
  readonly domain: string;
  readonly attempts: AttemptState;
  readonly now: number;
}

// Whether to ask the CA for a certificate now, given the one on disk (or
// none) and the attempts so far.
export function planRenewal(options: RenewalInput): RenewalDecision {
  const reason = findRenewalReason(options.info, options.domain, options.now);

  if (reason === null) {
    return { kind: 'keep' };
  }

  const last = options.attempts.lastAttemptAt;
  const until = last === null ? 0 : last + readBackoffMs(options.attempts.failures);

  return options.now < until ? { kind: 'wait', reason, until } : { kind: 'issue', reason };
}

function findRenewalReason(info: CertificateInfo | null, domain: string, now: number) {
  if (info === null) {
    return 'there is no certificate';
  }

  const missing = listCertificateNames(domain).filter((name) => !info.names.includes(name));

  if (missing.length > 0) {
    return `the certificate does not cover ${missing.join(', ')}`;
  }

  const notBefore = info.notBefore.getTime();
  const notAfter = info.notAfter.getTime();

  if (now >= notAfter) {
    return 'the certificate has expired';
  }

  if (now >= notBefore + (notAfter - notBefore) * RENEW_AT_FRACTION) {
    return `the certificate expires ${info.notAfter.toISOString()}`;
  }

  return null;
}
