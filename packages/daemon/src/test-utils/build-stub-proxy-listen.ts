import type { ProxyListenOptions } from '../proxy/wake-proxy';

// The wake proxy's listen, as the HTTPS listeners call it: a real server on
// the address, port (SO_REUSEPORT) and TLS asked for, answering
// `served on <address>`. Each start and stop lands in `events`.
export function buildStubProxyListen() {
  const events: string[] = [];

  return {
    events,
    startListener: (options: ProxyListenOptions) => {
      const hostname = options.hostname ?? '';

      const server = Bun.serve({
        port: options.port,
        ...(options.hostname !== undefined && { hostname: options.hostname }),
        ...(options.tls !== undefined && { tls: options.tls }),
        reusePort: true,
        fetch: () => new Response(`served on ${hostname}`),
      });

      events.push(`start ${hostname}`);

      return {
        port: server.port,
        stop: async (closeActiveConnections?: boolean) => {
          events.push(`stop ${hostname}`);

          await server.stop(closeActiveConnections);
        },
      };
    },
  };
}
