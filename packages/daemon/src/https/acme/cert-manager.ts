import { readErrorMessage } from '../../read-error-message';
import type { IssueCertificate } from './acme-issuer';
import { readCertificateInfo } from './acme-issuer';
import type { CertStore, Certificate } from './cert-store';
import type { CertificateInfo } from './renewal-policy';
import { planRenewal, readBackoffMs } from './renewal-policy';

export interface CertManager {
  // the certificate on disk, expired or not: an expired one still serves
  // better than none while a renewal fails
  readonly load: () => Certificate | null;

  // asks the CA when the certificate is due and the backoff allows; the new
  // certificate, or null when nothing changed. Never throws.
  readonly renew: () => Promise<Certificate | null>;
}

interface CertManagerOptions {
  readonly domain: string;
  readonly store: CertStore;
  readonly issue: IssueCertificate;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export function createCertManager(options: CertManagerOptions): CertManager {
  const domain = options.domain;
  const store = options.store;
  const log = options.log;

  // one renewal at a time; a second call joins the one under way
  let running: Promise<Certificate | null> | null = null;

  // the backoff end last logged, so a wait is logged once, not every tick
  let loggedWaitUntil: number | null = null;

  const readInfo = (certificate: Certificate | null): CertificateInfo | null => {
    if (certificate === null) {
      return null;
    }

    try {
      return readCertificateInfo(certificate.chainPem);
    } catch (error) {
      log(`impd: https: cannot read the stored certificate: ${readErrorMessage(error)}`);

      return null;
    }
  };

  const tryRenewal = async (): Promise<Certificate | null> => {
    const attempts = store.readAttempts();
    const now = options.now();

    const decision = planRenewal({
      info: readInfo(store.readCertificate()),
      domain,
      attempts,
      now,
    });

    if (decision.kind === 'keep') {
      return null;
    }

    if (decision.kind === 'wait') {
      if (loggedWaitUntil !== decision.until) {
        loggedWaitUntil = decision.until;

        log(
          `impd: https: ${decision.reason}; the next try is after ${new Date(decision.until).toISOString()}`,
        );
      }

      return null;
    }

    log(`impd: https: asking for a certificate for ${domain} and *.${domain}: ${decision.reason}`);

    // counted as failed before it starts: a crash in the middle still backs off
    const failures = attempts.failures + 1;

    store.writeAttempts({ failures, lastAttemptAt: now, lastError: attempts.lastError });

    try {
      const certificate = await options.issue(domain);

      store.writeCertificate(certificate);
      store.writeAttempts({ failures: 0, lastAttemptAt: now, lastError: null });

      const info = readInfo(certificate);
      const tookMs = options.now() - now;

      log(
        `impd: https: got a certificate for ${domain} in ${String(tookMs)}ms; it expires ${info?.notAfter.toISOString() ?? 'at an unknown time'}`,
      );

      return certificate;
    } catch (error) {
      const reason = readErrorMessage(error);

      const retryAt = new Date(now + readBackoffMs(failures)).toISOString();

      store.writeAttempts({ failures, lastAttemptAt: now, lastError: reason });

      loggedWaitUntil = now + readBackoffMs(failures);

      log(`impd: https: no certificate for ${domain}: ${reason}; the next try is after ${retryAt}`);

      return null;
    }
  };

  const runRenewal = async (): Promise<Certificate | null> => {
    try {
      return await tryRenewal();
    } catch (error) {
      log(`impd: https: renewal failed: ${readErrorMessage(error)}`);

      return null;
    } finally {
      running = null;
    }
  };

  return {
    load: () => {
      const certificate = store.readCertificate();
      const info = readInfo(certificate);

      if (certificate === null || info === null) {
        return null;
      }

      if (info.notAfter.getTime() <= options.now()) {
        log(
          `impd: https: the stored certificate expired ${info.notAfter.toISOString()}; serving it until a renewal succeeds`,
        );
      }

      return certificate;
    },
    renew: () => {
      running ??= runRenewal();

      return running;
    },
  };
}
