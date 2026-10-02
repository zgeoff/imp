import { Resolver } from 'node:dns/promises';

export interface WaitForTxtOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;

  // the TXT values one nameserver gives for a name; DNS by default
  readonly readTxt?: (server: string, fqdn: string) => Promise<readonly string[]>;

  // a nameserver's addresses; the system resolver by default
  readonly resolveServer?: (hostname: string) => Promise<readonly string[]>;
}

// Waits until every one of the zone's nameservers answers every value. A CA
// asks one of them, and a value only some of them have fails the challenge.
export async function waitForTxt(
  nameservers: readonly string[],
  fqdn: string,
  values: readonly string[],
  options: WaitForTxtOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 5000;
  const readTxt = options.readTxt ?? readTxtFromServer;
  const resolveServer = options.resolveServer ?? resolveServerAddresses;
  const deadline = Date.now() + timeoutMs;

  const addresses = await Promise.all(nameservers.map((name) => resolveServer(name)));

  const servers = addresses.flat();

  if (servers.length === 0) {
    throw new Error(`no address for the nameservers of ${fqdn}: ${nameservers.join(', ')}`);
  }

  for (;;) {
    const missing = await findMissing(servers, fqdn, values, readTxt);

    if (missing === null) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `the TXT record ${fqdn} did not reach nameserver ${missing} within ${String(timeoutMs / 1000)}s`,
      );
    }

    await Bun.sleep(intervalMs);
  }
}

// the first server that lacks a value, or null when all have every one
async function findMissing(
  servers: readonly string[],
  fqdn: string,
  values: readonly string[],
  readTxt: (server: string, fqdn: string) => Promise<readonly string[]>,
): Promise<string | null> {
  for (const server of servers) {
    let answer: readonly string[];

    try {
      answer = await readTxt(server, fqdn);
    } catch {
      // NXDOMAIN or a timeout: not there yet
      return server;
    }

    if (!values.every((value) => answer.includes(value))) {
      return server;
    }
  }

  return null;
}

async function readTxtFromServer(server: string, fqdn: string): Promise<readonly string[]> {
  const resolver = new Resolver({ timeout: 5000, tries: 1 });

  resolver.setServers([server]);

  // a long TXT value comes back in 255-byte chunks
  const records = await resolver.resolveTxt(fqdn);

  return records.map((chunks) => chunks.join(''));
}

async function resolveServerAddresses(hostname: string): Promise<readonly string[]> {
  const resolver = new Resolver();

  try {
    return await resolver.resolve4(hostname);
  } catch {
    return [];
  }
}
