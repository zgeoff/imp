import { expect, mock, test } from 'bun:test';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { impCollection } from '../mocks/db/imp-collection';
import { sessionCollection } from '../mocks/db/session-collection';
import { tokenCollection } from '../mocks/db/token-collection';
import { LOGIN_URL, LOGOUT_URL, resolveLogin } from '../mocks/handlers';
import { server } from '../mocks/node';
import { renderApp } from '../test-utils/render-app';

test('it stays on the login page with a message for a token impd does not know', async () => {
  const user = userEvent.setup();

  await tokenCollection.create({ secret: 'imp_ci.secret' });

  const rendered = renderApp('/login');

  const field = await rendered.findByLabelText('API token');

  await user.type(field, 'nope');
  await user.click(rendered.getByRole('button', { name: 'Log in' }));

  const alert = await rendered.findByRole('alert');

  expect(alert).toHaveTextContent('impd knows no such token.');
  expect(rendered.router.state.location.pathname).toBe('/login');
});

test('it sends the typed token to the session route of impd', async () => {
  const user = userEvent.setup();
  const received = mock<(body: unknown) => void>();

  server.use(
    http.post(LOGIN_URL, async (info) => {
      const body: unknown = await info.request.clone().json();

      received(body);

      return resolveLogin(info);
    }),
  );

  const rendered = renderApp('/login');

  const field = await rendered.findByLabelText('API token');

  await user.type(field, 'nope');
  await user.click(rendered.getByRole('button', { name: 'Log in' }));
  await rendered.findByRole('alert');

  expect(received).toHaveBeenCalledExactlyOnceWith({ token: 'nope' });
});

test('it opens the imps list for a token impd knows', async () => {
  const user = userEvent.setup();

  await tokenCollection.create({ secret: 'imp_ci.secret' });

  const rendered = renderApp('/login');

  const field = await rendered.findByLabelText('API token');

  await user.type(field, 'imp_ci.secret');
  await user.click(rendered.getByRole('button', { name: 'Log in' }));
  await rendered.findByRole('heading', { name: 'Imps' });

  expect(rendered.router.state.location.pathname).toBe('/');
});

test('it clears what the dashboard knew and opens the login page on log out', async () => {
  const user = userEvent.setup();

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const rendered = renderApp();

  await rendered.findByRole('row', { name: /web/ });
  await user.click(rendered.getByRole('button', { name: 'Log out' }));
  await rendered.findByLabelText('API token');

  expect(rendered.router.state.location.pathname).toBe('/login');
  expect(rendered.queryClient.getQueryCache().getAll()).toHaveLength(0);
});

test('it says so and stays when the log out fails', async () => {
  const user = userEvent.setup();

  await sessionCollection.create({});

  server.use(http.post(LOGOUT_URL, () => new HttpResponse(null, { status: 502 })));

  const rendered = renderApp();

  const button = await rendered.findByRole('button', { name: 'Log out' });

  await user.click(button);

  const alert = await rendered.findByRole('alert');

  expect(alert).toHaveTextContent('impd did not log out (HTTP 502)');
  expect(rendered.router.state.location.pathname).toBe('/');
});
