import type { DnsProvider } from './dns-provider';

// pebble-challtestsrv, the DNS server Pebble asks in tests
// (docs/guides/https.md#testing-with-pebble). Its management API sets the
// records; there is nothing to wait for, since it is the only nameserver.
export function createChalltestsrvProvider(apiUrl: string): DnsProvider {
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
    setA: async (fqdn, ip) => {
      await sendCommand('/add-a', { host: `${fqdn}.`, addresses: [ip] });
    },
  };
}
