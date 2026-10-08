import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sessionCollection } from '../mocks/db/session-collection';
import { tokenCollection } from '../mocks/db/token-collection';
import { renderApp } from '../test-utils/render-app';

test('it makes a token limited to some imps and shows its secret', async () => {
  const user = userEvent.setup();

  await sessionCollection.create({});

  const rendered = renderApp('/tokens');

  const field = await rendered.findByLabelText('Name');

  await user.type(field, 'ci');
  await user.selectOptions(rendered.getByLabelText('Scope'), 'exec');
  await user.type(rendered.getByLabelText('Imps'), 'dev-*, ci-*');
  await user.click(rendered.getByRole('button', { name: 'Make token' }));

  const card = await rendered.findByRole('region', { name: 'Secret of ci' });
  const row = await rendered.findByRole('row', { name: /ci/ });

  const token = tokenCollection.findFirst((query) => query.where({ name: 'ci' }));

  invariant(token);

  expect(within(card).getByText(token.secret)).toBeInTheDocument();
  expect(within(row).getByText('dev-*, ci-*')).toBeInTheDocument();
  expect(token.scope).toBe('exec');
  expect(token.imps).toStrictEqual(['dev-*', 'ci-*']);
});

test('it deletes a token after a confirm', async () => {
  const user = userEvent.setup();

  await sessionCollection.create({});
  await tokenCollection.create({ name: 'old' });

  const rendered = renderApp('/tokens');

  const row = await rendered.findByRole('row', { name: /old/ });

  await user.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Delete old?' });

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => {
    expect(rendered.queryByRole('row', { name: /old/ })).toBeNull();
  });

  expect(tokenCollection.count()).toBe(0);
});

test('it hides the tokens link from a caller limited to some imps', async () => {
  await sessionCollection.create({ name: 'dev', imps: ['dev-*'] });

  const rendered = renderApp('/');

  await rendered.findByText('dev (manage)');

  expect(rendered.queryByRole('link', { name: 'Tokens' })).toBeNull();
});

test('it links to tokens for a caller that manages the whole host', async () => {
  await sessionCollection.create({ name: 'root' });

  const rendered = renderApp('/');

  const link = await rendered.findByRole('link', { name: 'Tokens' });

  expect(link).toBeInTheDocument();
});

test('it lists the SSH keys bound to each token', async () => {
  await sessionCollection.create({});

  await tokenCollection.create({
    name: 'laptop',
    sshKeys: [{ fingerprint: 'SHA256:abc', type: 'ssh-ed25519', comment: 'me@laptop' }],
  });

  const rendered = renderApp('/tokens');

  const row = await rendered.findByRole('row', { name: /laptop/ });

  expect(within(row).getByText('me@laptop SHA256:abc')).toBeInTheDocument();
});
