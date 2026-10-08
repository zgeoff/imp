import { expect, mock, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { imageCollection } from '../mocks/db/image-collection';
import { RPC_URL } from '../mocks/handlers';
import { server } from '../mocks/node';
import { createDashboardSession } from '../test-utils/create-dashboard-session';
import { readRpcInput } from '../test-utils/read-rpc-input';
import { renderApp } from '../test-utils/render-app';

test('it lists each image with its size', async () => {
  await createDashboardSession();

  await imageCollection.create({ name: 'base', sizeBytes: 512 * 1024 * 1024 });

  const rendered = renderApp('/images');

  const row = await rendered.findByRole('row', { name: /base/ });

  expect(within(row).getByText('512 MiB')).toBeInTheDocument();
});

test('it adds an image from a ref', async () => {
  const user = userEvent.setup();

  await createDashboardSession();

  const rendered = renderApp('/images');

  const field = await rendered.findByLabelText('Image ref');

  await user.type(field, 'docker.io/library/node:22');
  await user.click(rendered.getByRole('button', { name: 'Add image' }));

  const row = await rendered.findByRole('row', { name: /docker\.io\/library\/node:22/ });

  expect(row).toBeInTheDocument();

  expect(imageCollection.findMany().map((image) => image.ref)).toStrictEqual([
    'docker.io/library/node:22',
  ]);
});

test('it sends only the ref of an image added without a name', async () => {
  const user = userEvent.setup();
  const received = mock<(input: unknown) => void>();

  await createDashboardSession();

  server.use(
    http.post(`${RPC_URL}/images/add`, async (info) => {
      const input = await readRpcInput(info.request);

      received(input);
    }),
  );

  const rendered = renderApp('/images');

  const field = await rendered.findByLabelText('Image ref');

  await user.type(field, 'docker.io/library/node:22');
  await user.click(rendered.getByRole('button', { name: 'Add image' }));
  await rendered.findByRole('row', { name: /docker\.io\/library\/node:22/ });

  expect(received).toHaveBeenCalledExactlyOnceWith({ ref: 'docker.io/library/node:22' });
});

test('it deletes an image after a confirm', async () => {
  const user = userEvent.setup();

  await createDashboardSession();

  await imageCollection.create({ name: 'base' });

  const rendered = renderApp('/images');

  const row = await rendered.findByRole('row', { name: /base/ });

  await user.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Delete base?' });

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => {
    expect(rendered.queryByRole('row', { name: /base/ })).toBeNull();
  });

  expect(imageCollection.count()).toBe(0);
});
