import { expect, test } from 'bun:test';
import { buildStubImpdBeforeExecDropSysAdmin } from './build-stub-impd-before-exec-drop-sys-admin';

test('it drops execDropSysAdmin from a system.info answer and keeps the rest', async () => {
  const older = buildStubImpdBeforeExecDropSysAdmin(() =>
    Promise.resolve(
      Response.json({
        json: { version: '2.0.8', features: { execDropSysAdmin: true, execRequire: true } },
      }),
    ),
  );

  const response = await older(new Request('http://impd.test/rpc/system/info', { method: 'POST' }));
  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    json: { version: '2.0.8', features: { execRequire: true } },
  });
});

test('it passes another call through unchanged', async () => {
  const answer = Response.json({ json: { features: { execDropSysAdmin: true } } });
  const older = buildStubImpdBeforeExecDropSysAdmin(() => Promise.resolve(answer));

  const response = await older(new Request('http://impd.test/rpc/imps/list', { method: 'POST' }));

  expect(response).toBe(answer);
});

test('it passes a refused system.info through unchanged', async () => {
  const answer = new Response(null, { status: 401 });

  const older = buildStubImpdBeforeExecDropSysAdmin(() => Promise.resolve(answer));

  const response = await older(new Request('http://impd.test/rpc/system/info', { method: 'POST' }));

  expect(response).toBe(answer);
});
