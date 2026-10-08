import { expect, mock, test } from 'bun:test';
import { createImpClient } from '@zgeoff/imp-client';
import { http } from 'msw';
import { impCollection } from '../mocks/db/imp-collection';
import { sessionCollection } from '../mocks/db/session-collection';
import { IMPD_ORIGIN, RPC_URL } from '../mocks/handlers';
import { server } from '../mocks/node';
import { readRpcInput } from './read-rpc-input';

test('it reads the input of a call as the procedure receives it', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });
  const received = mock<(input: unknown) => void>();

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  server.use(
    http.post(`${RPC_URL}/checkpoints/create`, async (info) => {
      const input = await readRpcInput(info.request);

      received(input);
    }),
  );

  await client.checkpoints.create({ name: 'web', label: 'v2' });

  expect(received).toHaveBeenCalledExactlyOnceWith({ name: 'web', label: 'v2' });
});

test('it leaves the request for the handler after it to read', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  server.use(
    http.post(`${RPC_URL}/checkpoints/create`, async (info) => {
      await readRpcInput(info.request);
    }),
  );

  const checkpoint = await client.checkpoints.create({ name: 'web', label: 'v2' });

  expect(checkpoint.label).toBe('v2');
});
