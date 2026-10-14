import { expect, test } from 'bun:test';
import { hostCollection } from '../mocks/db/host-collection';
import { createDashboardSession } from '../test-utils/create-dashboard-session';
import { renderApp } from '../test-utils/render-app';

test('it tells every page that the host needs a reboot after a kernel oops', async () => {
  await createDashboardSession();

  await hostCollection.create({ rebootReason: 'a kernel oops' });

  const rendered = renderApp('/images');

  const warning = await rendered.findByRole('alert');

  expect(warning).toHaveTextContent('host needs a reboot: a kernel oops');
});

test('it shows no reboot warning while the host needs none', async () => {
  await createDashboardSession();

  const rendered = renderApp('/ram');

  await rendered.findByRole('meter', { name: 'RAM in use' });

  expect(rendered.queryByText(/host needs a reboot/v)).toBeNull();
});
