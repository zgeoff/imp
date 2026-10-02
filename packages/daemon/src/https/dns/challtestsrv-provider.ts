import type { DnsProvider } from './dns-provider';

// pebble-challtestsrv, the DNS server Pebble asks in tests
// (docs/guides/https.md#testing-with-pebble). Its management API sets the
// records; there is nothing to wait for, since it is the only nameserver.
export function createChalltestsrvProvider(apiUrl: string): DnsProvider {
  // It has no list call, so the provider remembers what this impd wrote:
  // fqdn to owner and address. A restarted impd forgets, and the records it
  // wrote before stay until challtestsrv restarts.
  const records = new Map<string, { readonly owner: string; readonly ip: string }>();

  const sendCommand = async (path: string, body: unknown): Promise<void> => {
    const response = await fetch(new URL(path, apiUrl), {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`challtestsrv ${path}: ${String(response.status)}`);
    }
  };

  return {
    addTxt: async (fqdn, value) => {
      await sendCommand('/set-txt', { host: `${fqdn}.`, value });

      return { fqdn, value, id: value };
    },

    // it clears every value of the name at once; impd removes all of them
    // together after an attempt anyway
    removeTxt: async (record) => {
      await sendCommand('/clear-txt', { host: `${record.fqdn}.` });
    },

    // set as soon as the API answers
    waitForTxt: () => Promise.resolve(),
    setA: async (fqdn, ip, owner = 'managed by impd') => {
      await sendCommand('/add-a', { host: `${fqdn}.`, addresses: [ip] });

      records.set(fqdn, { owner, ip });
    },
    listA: (domain, owner) => {
      const found = [...records]
        .filter(([fqdn, record]) => fqdn.endsWith(`.${domain}`) && record.owner === owner)
        .map(([fqdn, record]) => [fqdn, record.ip] as const);

      return Promise.resolve(new Map(found));
    },
    removeA: async (fqdn, owner) => {
      if (records.get(fqdn)?.owner !== owner) {
        return;
      }

      await sendCommand('/clear-a', { host: `${fqdn}.` });

      records.delete(fqdn);
    },
  };
}
