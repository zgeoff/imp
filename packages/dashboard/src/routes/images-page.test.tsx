import { expect, test } from 'bun:test';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildImage, createFakeImpd } from '../test-utils/fake-impd';
import { renderApp } from '../test-utils/render-app';

test('it lists images and adds one from a ref', async () => {
  const fake = createFakeImpd();
  const user = userEvent.setup();

  fake.state.images.push(buildImage({ name: 'base' }));

  renderApp(fake, '/images');

  const row = await screen.findByRole('row', { name: /base/ });

  expect(within(row).getByText('512 MiB')).toBeInTheDocument();

  await user.type(screen.getByLabelText('Image ref'), 'docker.io/library/node:22');
  await user.click(screen.getByRole('button', { name: 'Add image' }));

  await waitFor(() => {
    expect(fake.state.calls).toEqual([
      { path: 'images.add', input: { ref: 'docker.io/library/node:22' } },
    ]);
  });
});

test('it deletes an image after a confirm', async () => {
  const fake = createFakeImpd();
  const user = userEvent.setup();

  fake.state.images.push(buildImage({ name: 'base' }));

  renderApp(fake, '/images');

  const row = await screen.findByRole('row', { name: /base/ });

  await user.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await screen.findByRole('dialog', { name: 'Delete base?' });

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => {
    expect(fake.state.calls).toEqual([{ path: 'images.delete', input: { name: 'base' } }]);
  });
});
