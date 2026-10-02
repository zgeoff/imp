import { Agent } from 'node:https';
import * as acme from 'acme-client';
import type { Challenge } from 'acme-client/types/rfc8555';
import { readErrorMessage } from '../../read-error-message';
import type { DnsProvider, TxtRecord } from '../dns/dns-provider';
import type { CertStore, Certificate } from './cert-store';
import type { CertificateInfo } from './renewal-policy';
import { listCertificateNames } from './renewal-policy';

export interface AcmeIssuerOptions {
  readonly directoryUrl: string;
  readonly email: string | null;

  // the PEM the ACME server's TLS chains to when it is not a public CA
  readonly caPem: string | null;
  readonly store: CertStore;
  readonly dns: DnsProvider;
  readonly log: (message: string) => void;
}

// a pending DNS-01 challenge: one per certificate name
interface PendingChallenge {
  readonly challenge: Challenge;
  readonly fqdn: string;
  readonly value: string;
}

export type IssueCertificate = (domain: string) => Promise<Certificate>;

// Issues one certificate for `<domain>` and `*.<domain>` with DNS-01. Both
// names share `_acme-challenge.<domain>`, so both TXT values go up and reach
// every nameserver before the CA is told to look at either.
export function createAcmeIssuer(options: AcmeIssuerOptions): IssueCertificate {
  if (options.caPem !== null) {
    // acme-client's own axios instance; impd talks to one ACME server
    acme.axios.defaults.httpsAgent = new Agent({ ca: options.caPem });
  }

  const readAccountKey = async (): Promise<string> => {
    const stored = options.store.readAccountKey();

    if (stored !== null) {
      return stored;
    }

    const created = await acme.crypto.createPrivateEcdsaKey();

    const pem = created.toString();

    options.store.writeAccountKey(pem);

    return pem;
  };

  const runOrder = async (domain: string): Promise<Certificate> => {
    await checkDirectory(options.directoryUrl, options.caPem);

    const accountKey = await readAccountKey();

    const accountUrl = options.store.readAccountUrl(options.directoryUrl);

    const client = new acme.Client({
      directoryUrl: options.directoryUrl,
      accountKey,
      ...(accountUrl !== null && { accountUrl }),
    });

    // An account the key already has goes by its URL. Asking to create it
    // again makes acme-client send an update that strict servers refuse.
    if (accountUrl === null) {
      await client.createAccount({
        termsOfServiceAgreed: true,
        ...(options.email !== null && { contact: [`mailto:${options.email}`] }),
      });

      options.store.writeAccountUrl(options.directoryUrl, client.getAccountUrl());
    }

    const names = listCertificateNames(domain);

    const order = await client.createOrder({
      identifiers: names.map((name) => ({ type: 'dns', value: name })),
    });

    const authorizations = await client.getAuthorizations(order);

    const records: TxtRecord[] = [];

    try {
      const pending: PendingChallenge[] = [];

      for (const authorization of authorizations) {
        if (authorization.status === 'valid') {
          continue;
        }

        const name = authorization.identifier.value;
        const challenge = authorization.challenges.find((item) => item.type === 'dns-01');

        if (challenge === undefined) {
          throw new Error(`the CA offers no dns-01 challenge for ${name}`);
        }

        const fqdn = `_acme-challenge.${name}`;

        const value = await client.getChallengeKeyAuthorization(challenge);
        const record = await options.dns.addTxt(fqdn, value);

        records.push(record);
        pending.push({ challenge, fqdn, value });
      }

      for (const fqdn of new Set(pending.map((item) => item.fqdn))) {
        const values = pending.filter((item) => item.fqdn === fqdn).map((item) => item.value);

        await options.dns.waitForTxt(fqdn, values);
      }

      for (const item of pending) {
        await client.completeChallenge(item.challenge);
        await client.waitForValidStatus(item.challenge);
      }

      const certificateKey = await acme.crypto.createPrivateEcdsaKey();

      const [key, csr] = await acme.crypto.createCsr(
        { commonName: domain, altNames: [...names] },
        certificateKey,
      );

      const finalized = await client.finalizeOrder(order, csr);
      const chainPem = await client.getCertificate(finalized);

      return { keyPem: key.toString(), chainPem };
    } finally {
      await removeRecords(options, records);
    }
  };

  return async (domain) => {
    try {
      return await runOrder(domain);
    } catch (error) {
      throw new Error(formatAcmeError(error), { cause: error });
    }
  };
}

export function readCertificateInfo(chainPem: string): CertificateInfo {
  const info = acme.crypto.readCertificateInfo(chainPem);

  const names = new Set([info.domains.commonName, ...info.domains.altNames]);

  names.delete('');

  return { notBefore: info.notBefore, notAfter: info.notAfter, names: [...names] };
}

// a failed removal leaves a stale TXT value, which harms nothing
async function removeRecords(
  options: AcmeIssuerOptions,
  records: readonly TxtRecord[],
): Promise<void> {
  for (const record of records) {
    try {
      await options.dns.removeTxt(record);
    } catch (error) {
      const reason = readErrorMessage(error);

      options.log(`impd: https: could not remove the TXT record ${record.fqdn}: ${reason}`);
    }
  }
}

// Under Bun a failed TLS handshake inside acme-client reads only `undefined
// is not an object (evaluating 'response.config')`. Asking the directory
// first, with fetch, gives the real reason.
async function checkDirectory(directoryUrl: string, caPem: string | null): Promise<void> {
  try {
    const response = await fetch(directoryUrl, {
      ...(caPem !== null && { tls: { ca: caPem } }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
  } catch (error) {
    throw new Error(`cannot reach the ACME server at ${directoryUrl}: ${readErrorMessage(error)}`, {
      cause: error,
    });
  }
}

// the same failure later in the flow, once the directory has answered
function formatAcmeError(error: unknown): string {
  const message = readErrorMessage(error);

  if (error instanceof TypeError && message.includes('response.config')) {
    return 'the ACME server did not answer (a connection or TLS failure)';
  }

  return message;
}
