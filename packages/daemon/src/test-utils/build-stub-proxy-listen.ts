import type { ProxyListenOptions } from '../proxy/wake-proxy';

// The wake proxy's listen as wake-proxy.ts binds it (reusePort only when
// asked, no idle timeout); a request runs the route and answers
// `served on <address>`, its route kind in `routes` and `x-route`.
export function buildStubProxyListen() {
  const events: string[] = [];
  const routes: string[] = [];

  return {
    events,
    routes,
    startListener: (options: ProxyListenOptions) => {
      const hostname = options.hostname ?? '';

      const server = Bun.serve({
        port: options.port,
        ...(options.hostname !== undefined && { hostname: options.hostname }),
        ...(options.tls !== undefined && { tls: options.tls }),
        ...(options.reusePort === true && { reusePort: true }),
        idleTimeout: 0,
        fetch: async (request) => {
          const route = await options.route(request);

          routes.push(route.kind);

          return new Response(`served on ${hostname}`, { headers: { 'x-route': route.kind } });
        },
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
