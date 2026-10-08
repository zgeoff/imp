// What one curl run printed, and how it ended
export interface StubGuestResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface StubGuestOptions {
  // the broker's front port on the gateway, 127.0.0.1
  readonly proxyPort: number;

  // the broker CA the guest trusts, as its bundle install puts it there
  readonly caFile: string;

  // the guest's own address: a loopback one stands for a slot's guest
  readonly address: string;
}

// A guest's HTTPS client: curl bound to the guest's address, through the
// broker's front port as its proxy, trusting the broker CA and nothing else.
export function buildStubBrokerGuest(options: Readonly<StubGuestOptions>) {
  return {
    curl: async (url: string, extra: readonly string[] = []): Promise<StubGuestResult> => {
      const child = Bun.spawn(
        [
          'curl',
          '-sS',
          '--max-time',
          '10',
          '--interface',
          options.address,
          '--proxy',
          `http://127.0.0.1:${String(options.proxyPort)}`,
          '--cacert',
          options.caFile,
          ...extra,
          url,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { code, stdout, stderr };
    },
  };
}
