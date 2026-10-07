import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildMockCheckpoint } from '../test-utils/build-mock-checkpoint';
import { buildMockDiskUsage } from '../test-utils/build-mock-disk-usage';
import { buildMockImp } from '../test-utils/build-mock-imp';
import { buildMockImpResources } from '../test-utils/build-mock-imp-resources';
import { buildStubImpd } from '../test-utils/build-stub-impd';
import { renderApp } from '../test-utils/render-app';

test('it shows the RAM and disk use of the imp', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(
    buildMockImp({
      name: 'web',
      ramMib: 300,
      rssMib: 340,
      diskMib: 32_768,
      diskUsage: buildMockDiskUsage({
        exclusiveBytes: 1024 * 1024 * 1024,
        sharedBytes: 512 * 1024 * 1024,
        isPartial: false,
        isUpperBound: false,
      }),
    }),
  );

  const rendered = renderApp(stub, '/imps/web');

  await rendered.findByRole('heading', { name: 'web' });

  expect(rendered.getByText('300 MiB owned, 340 MiB resident')).toBeInTheDocument();
  expect(rendered.getByText('1.0 GiB / 32.0 GiB, 512 MiB shared')).toBeInTheDocument();
});

test('it lists the checkpoints of the imp', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));
  stub.state.checkpoints.set('web', [buildMockCheckpoint({ label: 'before-upgrade' })]);

  const rendered = renderApp(stub, '/imps/web');

  const row = await rendered.findByRole('row', { name: /before-upgrade/ });

  expect(row).toBeInTheDocument();
});

test('it takes a checkpoint with a label', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  const rendered = renderApp(stub, '/imps/web');

  const field = await rendered.findByLabelText('Label');

  await user.type(field, 'v2');
  await user.click(rendered.getByRole('button', { name: 'Checkpoint now' }));
  await rendered.findByRole('row', { name: /v2/ });

  expect(stub.state.calls).toStrictEqual([
    { path: 'checkpoints.create', input: { name: 'web', label: 'v2' } },
  ]);
});

test('it restores the named checkpoint after a confirm', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.imps.push(buildMockImp({ name: 'web' }));
  stub.state.checkpoints.set('web', [buildMockCheckpoint({ id: 'cp1', label: 'before-upgrade' })]);

  const rendered = renderApp(stub, '/imps/web');

  const row = await rendered.findByRole('row', { name: /before-upgrade/ });

  await user.click(within(row).getByRole('button', { name: 'Restore' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Restore web?' });

  await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

  await waitFor(() => {
    expect(stub.state.calls).toStrictEqual([
      { path: 'checkpoints.restore', input: { name: 'web', checkpoint: 'cp1' } },
    ]);
  });
});

test('it opens the new imp after a fork from a checkpoint', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.imps.push(buildMockImp({ name: 'web' }));
  stub.state.checkpoints.set('web', [buildMockCheckpoint({ id: 'cp1', label: 'before-upgrade' })]);

  const rendered = renderApp(stub, '/imps/web');

  const row = await rendered.findByRole('row', { name: /before-upgrade/ });

  await user.click(within(row).getByRole('button', { name: 'Fork' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Fork web' });

  await user.type(within(dialog).getByLabelText('New name'), 'web2');
  await user.click(within(dialog).getByRole('button', { name: 'Fork' }));
  await rendered.findByRole('heading', { name: 'web2' });

  expect(rendered.router.state.location.pathname).toBe('/imps/web2');

  expect(stub.state.calls).toStrictEqual([
    { path: 'imps.fork', input: { source: 'web', name: 'web2', checkpoint: 'cp1' } },
  ]);
});

test('it says so when the imp does not exist', async () => {
  const rendered = renderApp(buildStubImpd(), '/imps/gone');

  const alert = await rendered.findByRole('alert');

  expect(alert).toHaveTextContent('imp gone not found');
});

test('it goes back to the list without asking for the imp it destroyed', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  const rendered = renderApp(stub, '/imps/web');

  const button = await rendered.findByRole('button', { name: 'Destroy' });

  await user.click(button);

  const dialog = await rendered.findByRole('dialog', { name: 'Destroy web?' });

  await user.click(within(dialog).getByRole('button', { name: 'Destroy' }));
  await rendered.findByRole('heading', { name: 'Imps' });

  expect(rendered.router.state.location.pathname).toBe('/');
  expect(stub.state.notFound).toBe(0);
});

test('it shows the network use and awake time of the running imp', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(
    buildMockImp({
      name: 'web',
      resources: buildMockImpResources({
        awakeMs: 200 * 60_000,
        sample: { netRxBytes: 2048, netTxBytes: 512 },
      }),
    }),
  );

  const rendered = renderApp(stub, '/imps/web');

  const network = await rendered.findByText('2.0 KiB in, 512 B out');

  expect(network).toBeInTheDocument();
  expect(rendered.getByText('3h 20m')).toBeInTheDocument();
});

test('it sets a CPU limit on the running imp', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.imps.push(
    buildMockImp({
      name: 'web',
      cpu: { limit: null, weight: 100 },
      resources: buildMockImpResources({ sample: { cpuPercent: 45 } }),
    }),
  );

  const rendered = renderApp(stub, '/imps/web');

  const field = await rendered.findByLabelText('Limit (CPUs)');

  await user.type(field, '0.5');
  await user.click(rendered.getByRole('button', { name: 'Save' }));

  const cpu = await rendered.findByText('45% / 0.5');

  expect(cpu).toBeInTheDocument();

  expect(stub.state.calls).toStrictEqual([
    { path: 'imps.update', input: { name: 'web', cpuLimit: 0.5, cpuWeight: 100 } },
  ]);
});
