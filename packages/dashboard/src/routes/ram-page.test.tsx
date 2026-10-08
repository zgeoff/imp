import { expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import { impCollection } from '../mocks/db/imp-collection';
import { createDashboardSession } from '../test-utils/create-dashboard-session';
import { renderApp } from '../test-utils/render-app';

test('it lists imps by the RAM they own, largest first', async () => {
  await createDashboardSession();

  await impCollection.create({ name: 'idle', state: 'sleeping' });
  await impCollection.create({ name: 'small', ramMib: 100, rssMib: 150 });
  await impCollection.create({ name: 'big', ramMib: 900, rssMib: 1000 });

  const rendered = renderApp('/ram');

  await rendered.findByRole('row', { name: /big/ });

  const names = rendered
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getByRole('link').textContent);

  expect(names).toStrictEqual(['big', 'small', 'idle']);
});

test('it shows the RAM an imp owns, its resident memory and its size', async () => {
  await createDashboardSession();

  await impCollection.create({ name: 'small', ramMib: 100, rssMib: 150, memoryMib: 2048 });

  const rendered = renderApp('/ram');

  const row = await rendered.findByRole('row', { name: /small/ });

  expect(row).toHaveTextContent('100 MiB150 MiB2.0 GiB');
});

test('it shows the RAM meter of the host', async () => {
  await createDashboardSession();

  const rendered = renderApp('/ram');

  const meter = await rendered.findByRole('meter', { name: 'RAM in use' });

  expect(meter).toBeInTheDocument();
});
