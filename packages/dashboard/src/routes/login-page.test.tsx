import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeImpd } from '../test-utils/fake-impd';
import { renderApp } from '../test-utils/render-app';

afterEach(() => {
  mock.restore();
});

test('a wrong token stays on the login page with a message', async () => {
  const user = userEvent.setup();

  const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, { status: 401 }),
  );

  renderApp(createFakeImpd(), '/login');

  const field = await screen.findByLabelText('API token');

  await user.type(field, 'nope');
  await user.click(screen.getByRole('button', { name: 'Log in' }));

  const alert = await screen.findByRole('alert');

  expect(alert).toHaveTextContent('That is not impd’s token.');

  const [url, init] = fetchSpy.mock.calls[0] ?? [];

  expect(url).toBe('/auth/login');
  expect(init?.body).toBe('{"token":"nope"}');
});

test('the right token opens the imps list', async () => {
  const user = userEvent.setup();

  spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

  const rendered = renderApp(createFakeImpd(), '/login');

  const field = await screen.findByLabelText('API token');

  await user.type(field, 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByRole('heading', { name: 'Imps' });

  expect(rendered.router.state.location.pathname).toBe('/');
});

test('a 401 from impd sends the browser to the login page', async () => {
  const fake = createFakeImpd();

  fake.state.unauthorized = true;

  const rendered = renderApp(fake);

  await screen.findByLabelText('API token');

  expect(rendered.router.state.location.pathname).toBe('/login');
});
