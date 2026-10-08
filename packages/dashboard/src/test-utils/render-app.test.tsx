import { expect, test } from 'bun:test';
import { impCollection } from '../mocks/db/imp-collection';
import { createDashboardSession } from './create-dashboard-session';
import { renderApp } from './render-app';

test('it renders the page at the given path under /ui', async () => {
  await createDashboardSession();

  const rendered = renderApp('/images');

  const heading = await rendered.findByRole('heading', { name: 'Images' });

  expect(heading).toBeInTheDocument();
  expect(rendered.router.state.location.pathname).toBe('/images');
});

test('it renders the imps list when no path is given', async () => {
  await createDashboardSession();

  const rendered = renderApp();

  const heading = await rendered.findByRole('heading', { name: 'Imps' });

  expect(heading).toBeInTheDocument();
});

test('it answers queries from the mock impd', async () => {
  await createDashboardSession();

  await impCollection.create({ name: 'web' });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/ });

  expect(row).toBeInTheDocument();
});

test('it opens the login page when the browser holds no session', async () => {
  const rendered = renderApp('/images');

  await rendered.findByLabelText('API token');

  expect(rendered.router.state.location.pathname).toBe('/login');
});
