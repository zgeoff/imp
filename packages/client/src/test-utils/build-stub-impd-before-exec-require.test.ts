import { expect, test } from 'bun:test';
import { buildStubImpdBeforeExecRequire } from './build-stub-impd-before-exec-require';

test('it drops execRequire from a system.info answer and keeps the rest', async () => {
  const older = buildStubImpdBeforeExecRequire(() =>
    Promise.resolve(
      Response.json({
        json: { version: '0.40.2', features: { execRequire: true, leases: true } },
      }),
    ),
  );

  const response = await older(new Request('http://impd.test/rpc/system/info', { method: 'POST' }));
  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    json: { version: '0.40.2', features: { leases: true } },
  });
});

test('it passes another call through unchanged', async () => {
  const answer = Response.json({ json: { features: { execRequire: true } } });
  const older = buildStubImpdBeforeExecRequire(() => Promise.resolve(answer));

  const response = await older(new Request('http://impd.test/rpc/imps/list', { method: 'POST' }));

  expect(response).toBe(answer);
});

test('it passes a refused system.info through unchanged', async () => {
  const answer = new Response(null, { status: 401 });

  const older = buildStubImpdBeforeExecRequire(() => Promise.resolve(answer));

  const response = await older(new Request('http://impd.test/rpc/system/info', { method: 'POST' }));

  expect(response).toBe(answer);
});
