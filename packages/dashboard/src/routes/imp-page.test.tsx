import { expect, test } from 'bun:test';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildImp, createFakeImpd } from '../test-utils/fake-impd';
import { renderApp } from '../test-utils/render-app';

function setupTest() {
  const fake = createFakeImpd();

  fake.state.imps.push(buildImp({ name: 'web', ramMib: 300, rssMib: 340 }));

  fake.state.checkpoints.set('web', [
    { id: 'cp1', label: 'before-upgrade', createdAt: new Date(), sizeBytes: 2048, diskMib: 32_768 },
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

test('destroying the imp goes back to the list without an error', async () => {
  const ctx = setupTest();
  const rendered = renderApp(ctx.fake, '/imps/web');

  const destroy = await screen.findByRole('button', { name: 'Destroy' });

  await ctx.user.click(destroy);

  const dialog = await screen.findByRole('dialog', { name: 'Destroy web?' });

  await ctx.user.click(within(dialog).getByRole('button', { name: 'Destroy' }));
  await screen.findByRole('heading', { name: 'Imps' });

  expect(rendered.router.state.location.pathname).toBe('/');

  // the page never asked for the imp it had just destroyed
  expect(ctx.fake.state.notFound).toBe(0);
});

test('it shows the CPU sample and sets a limit on the running imp', async () => {
  const ctx = setupTest();

  ctx.fake.state.imps[0] = buildImp({
    name: 'web',
    cpu: { limit: null, weight: 100 },
    resources: {
      wakeCount: 3,
      awakeMs: 200 * 60_000,
      sample: {
        measuredAt: new Date(),
        since: new Date(),
        cpuPercent: 45,
        cpuThrottledMs: 1500,
        netRxBytes: 2048,
        netTxBytes: 512,
      },
    },
  });

  renderApp(ctx.fake, '/imps/web');

  await screen.findByText('2.0 KiB in, 512 B out');

  expect(screen.getByText('3h 20m')).toBeInTheDocument();

  await ctx.user.type(screen.getByLabelText('Limit (CPUs)'), '0.5');
  await ctx.user.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('45% / 0.5');

  expect(ctx.fake.state.calls).toEqual([
    { path: 'imps.update', input: { name: 'web', cpuLimit: 0.5, cpuWeight: 100 } },
  ]);
});
