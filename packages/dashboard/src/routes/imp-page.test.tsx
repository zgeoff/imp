import { expect, test } from 'bun:test';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildImp, createFakeImpd } from '../test-utils/fake-impd';
import { renderApp } from '../test-utils/render-app';

function setupTest() {
  const fake = createFakeImpd();

  fake.state.imps.push(buildImp({ name: 'web', ramMib: 300, rssMib: 340 }));

  fake.state.checkpoints.set('web', [
    { id: 'cp1', label: 'before-upgrade', createdAt: new Date(), sizeBytes: 2048 },
  ]);

  return { fake, user: userEvent.setup() };
}

test('it shows the imp with its RAM and checkpoints', async () => {
  const ctx = setupTest();

  renderApp(ctx.fake, '/imps/web');

  await screen.findByRole('heading', { name: 'web' });

  expect(screen.getByText('300 MiB owned, 340 MiB resident')).toBeInTheDocument();

  await screen.findByRole('row', { name: /before-upgrade/ });
});

test('it takes a checkpoint with a label', async () => {
  const ctx = setupTest();

  renderApp(ctx.fake, '/imps/web');

  const field = await screen.findByLabelText('Label');

  await ctx.user.type(field, 'v2');
  await ctx.user.click(screen.getByRole('button', { name: 'Checkpoint now' }));
  await screen.findByRole('row', { name: /v2/ });

  expect(ctx.fake.state.calls).toEqual([
    { path: 'checkpoints.create', input: { name: 'web', label: 'v2' } },
  ]);
});

test('a restore asks first and names the checkpoint', async () => {
  const ctx = setupTest();

  renderApp(ctx.fake, '/imps/web');

  const row = await screen.findByRole('row', { name: /before-upgrade/ });

  await ctx.user.click(within(row).getByRole('button', { name: 'Restore' }));

  const dialog = await screen.findByRole('dialog', { name: 'Restore web?' });

  await ctx.user.click(within(dialog).getByRole('button', { name: 'Restore' }));

  await waitFor(() => {
    expect(ctx.fake.state.calls).toEqual([
      { path: 'checkpoints.restore', input: { name: 'web', checkpoint: 'cp1' } },
    ]);
  });
});

test('a fork from a checkpoint opens the new imp', async () => {
  const ctx = setupTest();
  const rendered = renderApp(ctx.fake, '/imps/web');

  const row = await screen.findByRole('row', { name: /before-upgrade/ });

  await ctx.user.click(within(row).getByRole('button', { name: 'Fork' }));

  const dialog = await screen.findByRole('dialog', { name: 'Fork web' });

  await ctx.user.type(within(dialog).getByLabelText('New name'), 'web2');
  await ctx.user.click(within(dialog).getByRole('button', { name: 'Fork' }));
  await screen.findByRole('heading', { name: 'web2' });

  expect(rendered.router.state.location.pathname).toBe('/imps/web2');

  expect(ctx.fake.state.calls).toEqual([
    { path: 'imps.fork', input: { source: 'web', name: 'web2', checkpoint: 'cp1' } },
  ]);
});

test('it says so when the imp does not exist', async () => {
  const ctx = setupTest();

  renderApp(ctx.fake, '/imps/gone');

  const alert = await screen.findByRole('alert');

  expect(alert).toHaveTextContent('there is no imp named gone');
});
