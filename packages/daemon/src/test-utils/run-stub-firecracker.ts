// Firecracker's API on the socket its argv names, in a process of its own;
// start-stub-firecracker.ts builds the argv. GET / answers the VM's state,
// which PATCH /vm sets.
import { appendFileSync } from 'node:fs';

const [apiSocket = '', log = '', fail = 'none', mode = 'lines'] = process.argv.slice(-4);
const failures = fail === 'none' ? [] : fail.split(',');
const vm = { state: 'Running' };

Bun.serve({
  unix: apiSocket,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;

    const body = await request.text();

    const call = body === '' ? `${request.method} ${path}` : `${request.method} ${path} ${body}`;

    appendFileSync(log, `${mode === 'bodies' ? call : `${request.method} ${path}`}\n`);

    if (failures.some((prefix) => call.startsWith(prefix))) {
      return Response.json({ fault_message: `refused ${request.method} ${path}` }, { status: 400 });
    }

    if (path === '/version') {
      return Response.json({ firecracker_version: 'v1.17.0' });
    }

    if (path === '/') {
      return Response.json({ id: 'anonymous-instance', state: vm.state });
    }

    if (request.method === 'PATCH' && path === '/vm') {
      const patch: unknown = JSON.parse(body);

      vm.state =
        typeof patch === 'object' && patch !== null && 'state' in patch && patch.state === 'Paused'
          ? 'Paused'
          : 'Running';
    }

    return new Response(null, { status: 204 });
  },
});
