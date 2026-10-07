import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildMockImage } from '../test-utils/build-mock-image';
import { buildStubImpd } from '../test-utils/build-stub-impd';
import { renderApp } from '../test-utils/render-app';

test('it lists each image with its size', async () => {
  const stub = buildStubImpd();

  stub.state.images.push(buildMockImage({ name: 'base', sizeBytes: 512 * 1024 * 1024 }));

  const rendered = renderApp(stub, '/images');

  const row = await rendered.findByRole('row', { name: /base/ });

  expect(within(row).getByText('512 MiB')).toBeInTheDocument();
});

test('it adds an image from a ref', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();
  const rendered = renderApp(stub, '/images');

  const field = await rendered.findByLabelText('Image ref');

  await user.type(field, 'docker.io/library/node:22');
  await user.click(rendered.getByRole('button', { name: 'Add image' }));

  await waitFor(() => {
    expect(stub.state.calls).toStrictEqual([
      { path: 'images.add', input: { ref: 'docker.io/library/node:22' } },
    ]);
  });
});

test('it deletes an image after a confirm', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.images.push(buildMockImage({ name: 'base' }));

  const rendered = renderApp(stub, '/images');

  const row = await rendered.findByRole('row', { name: /base/ });

  await user.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Delete base?' });

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => {
    expect(stub.state.calls).toStrictEqual([{ path: 'images.delete', input: { name: 'base' } }]);
  });
});
