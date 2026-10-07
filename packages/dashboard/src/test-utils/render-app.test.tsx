import { expect, test } from 'bun:test';
import { buildMockImp } from './build-mock-imp';
import { buildStubImpd } from './build-stub-impd';
import { renderApp } from './render-app';

test('it renders the page at the given path under /ui', async () => {
  const rendered = renderApp(buildStubImpd(), '/images');

  const heading = await rendered.findByRole('heading', { name: 'Images' });

  expect(heading).toBeInTheDocument();
  expect(rendered.router.state.location.pathname).toBe('/images');
});

test('it renders the imps list when no path is given', async () => {
  const rendered = renderApp(buildStubImpd());

  const heading = await rendered.findByRole('heading', { name: 'Imps' });

  expect(heading).toBeInTheDocument();
});

test('it answers queries from the stub impd it is given', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  const rendered = renderApp(stub);

  const row = await rendered.findByRole('row', { name: /web/ });

  expect(row).toBeInTheDocument();
});

test('it opens the login page when the stub impd answers with a 401', async () => {
  const stub = buildStubImpd();

  stub.state.unauthorized = true;

  const rendered = renderApp(stub, '/images');

  await rendered.findByLabelText('API token');

  expect(rendered.router.state.location.pathname).toBe('/login');
});
