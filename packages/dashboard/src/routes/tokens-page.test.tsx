import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildMockIdentity } from '../test-utils/build-mock-identity';
import { buildMockToken } from '../test-utils/build-mock-token';
import { buildStubImpd } from '../test-utils/build-stub-impd';
import { renderApp } from '../test-utils/render-app';

test('it makes a token limited to some imps and shows its secret once', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();
  const rendered = renderApp(stub, '/tokens');

  const field = await rendered.findByLabelText('Name');

  await user.type(field, 'ci');
  await user.selectOptions(rendered.getByLabelText('Scope'), 'exec');
  await user.type(rendered.getByLabelText('Imps'), 'dev-*, ci-*');
  await user.click(rendered.getByRole('button', { name: 'Make token' }));

  const card = await rendered.findByRole('region', { name: 'Secret of ci' });
  const row = await rendered.findByRole('row', { name: /ci/ });

  expect(within(card).getByText('imp_stub.ci-secret')).toBeInTheDocument();
  expect(within(row).getByText('dev-*, ci-*')).toBeInTheDocument();

  expect(stub.state.calls).toStrictEqual([
    { path: 'tokens.create', input: { name: 'ci', scope: 'exec', imps: ['dev-*', 'ci-*'] } },
  ]);
});

test('it deletes a token after a confirm', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.tokens.push(buildMockToken({ name: 'old' }));

  const rendered = renderApp(stub, '/tokens');

  const row = await rendered.findByRole('row', { name: /old/ });

  await user.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Delete old?' });

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => {
    expect(stub.state.calls).toStrictEqual([{ path: 'tokens.delete', input: { name: 'old' } }]);
  });
});

test('it hides the tokens link from a caller limited to some imps', async () => {
  const stub = buildStubImpd();

  stub.state.identity = buildMockIdentity({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const rendered = renderApp(stub, '/');

  await rendered.findByText('dev (manage)');

  expect(rendered.queryByRole('link', { name: 'Tokens' })).toBeNull();
});

test('it links to tokens for a caller that manages the whole host', async () => {
  const stub = buildStubImpd();

  stub.state.identity = buildMockIdentity({ name: 'root', scope: 'manage', imps: null });

  const rendered = renderApp(stub, '/');

  const link = await rendered.findByRole('link', { name: 'Tokens' });

  expect(link).toBeInTheDocument();
});

test('it lists the SSH keys bound to each token', async () => {
  const stub = buildStubImpd();

  stub.state.tokens.push(
    buildMockToken({
      name: 'laptop',
      sshKeys: [{ fingerprint: 'SHA256:abc', type: 'ssh-ed25519', comment: 'me@laptop' }],
    }),
  );

  const rendered = renderApp(stub, '/tokens');

  const row = await rendered.findByRole('row', { name: /laptop/ });

  expect(within(row).getByText('me@laptop SHA256:abc')).toBeInTheDocument();
});
