import { expect, test } from 'bun:test';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeImpd } from '../test-utils/fake-impd';
import { renderApp } from '../test-utils/render-app';

test('it makes a token limited to some imps and shows its secret once', async () => {
  const fake = createFakeImpd();
  const user = userEvent.setup();

  renderApp(fake, '/tokens');

  const name = await screen.findByLabelText('Name');

  await user.type(name, 'ci');
  await user.selectOptions(screen.getByLabelText('Scope'), 'exec');
  await user.type(screen.getByLabelText('Imps'), 'dev-*, ci-*');
  await user.click(screen.getByRole('button', { name: 'Make token' }));

  const card = await screen.findByRole('region', { name: 'Secret of ci' });

  expect(within(card).getByText('imp_fake.ci-secret')).toBeInTheDocument();

  expect(fake.state.calls).toEqual([
    { path: 'tokens.create', input: { name: 'ci', scope: 'exec', imps: ['dev-*', 'ci-*'] } },
  ]);

  const row = await screen.findByRole('row', { name: /ci/ });

  expect(within(row).getByText('dev-*, ci-*')).toBeInTheDocument();
});

test('it deletes a token after a confirm', async () => {
  const fake = createFakeImpd();
  const user = userEvent.setup();

  fake.state.tokens.push({ name: 'old', scope: 'read', imps: null, createdAt: new Date() });

  renderApp(fake, '/tokens');

  const row = await screen.findByRole('row', { name: /old/ });

  await user.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await screen.findByRole('dialog', { name: 'Delete old?' });

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => {
    expect(fake.state.calls).toEqual([{ path: 'tokens.delete', input: { name: 'old' } }]);
  });
});

test('the nav offers tokens only to a caller that manages the whole host', async () => {
  const fake = createFakeImpd();

  fake.state.identity = { kind: 'dashboard', name: 'dev', scope: 'manage', imps: ['dev-*'] };

  renderApp(fake, '/');

  const identity = await screen.findByText('dev (manage)');

  expect(identity).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Tokens' })).toBeNull();
});

test('the nav links to tokens for the root token', async () => {
  renderApp(createFakeImpd(), '/');

  const link = await screen.findByRole('link', { name: 'Tokens' });

  expect(link).toBeInTheDocument();
});
