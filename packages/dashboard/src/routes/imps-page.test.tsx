import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildMockImp } from '../test-utils/build-mock-imp';
import { buildMockImpChangedEvent } from '../test-utils/build-mock-imp-changed-event';
import { buildMockSystemInfo } from '../test-utils/build-mock-system-info';
import { buildStubImpd } from '../test-utils/build-stub-impd';
import { renderApp } from '../test-utils/render-app';

test('it lists a running imp with its state, RAM, disk and a sleep button', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(
    buildMockImp({ name: 'web', state: 'running', ramMib: 300, diskMib: 32_768 }),
  );

  const rendered = renderApp(stub);

  const row = await rendered.findByRole('row', { name: /web/ });

  expect(within(row).getByText('running')).toBeInTheDocument();
  expect(within(row).getByText(/300 MiB/)).toBeInTheDocument();
  expect(within(row).getByText('— / 32.0 GiB')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Sleep' })).toBeInTheDocument();
});

test('it lists a sleeping imp with its notes and a wake button', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(
    buildMockImp({ name: 'old', state: 'sleeping', coldBootReason: 'the kernel changed' }),
  );

  const rendered = renderApp(stub);

  const row = await rendered.findByRole('row', { name: /old/ });

  expect(within(row).getByText('next wake boots cold: the kernel changed')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Wake' })).toBeInTheDocument();
});

test('it lists a failed imp with its error and a restart button', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(
    buildMockImp({ name: 'bad', state: 'error', error: 'boot failed: no agent' }),
  );

  const rendered = renderApp(stub);

  const row = await rendered.findByRole('row', { name: /bad/ });

  expect(within(row).getByText('boot failed: no agent')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Restart' })).toBeInTheDocument();
});

test('it shows the RAM in use against the budget of the host', async () => {
  const stub = buildStubImpd();

  stub.state.info = buildMockSystemInfo({ ramBudgetMib: 4096, ramUsedMib: 1024 });

  const rendered = renderApp(stub);

  const meter = await rendered.findByRole('meter', { name: 'RAM in use' });

  expect(meter).toHaveAttribute('aria-valuenow', '1024');
  expect(rendered.getByText('1.0 GiB of 4.0 GiB')).toBeInTheDocument();
});

test('it invites a first imp when there are none', async () => {
  const rendered = renderApp(buildStubImpd());

  const invite = await rendered.findByText('No imps yet. Make one with New imp.');

  expect(invite).toBeInTheDocument();
});

test('it moves the row of an imp to the state its lifecycle button asks for', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.imps.push(buildMockImp({ name: 'web', state: 'running' }));

  const rendered = renderApp(stub);

  const row = await rendered.findByRole('row', { name: /web/ });

  await user.click(within(row).getByRole('button', { name: 'Sleep' }));

  const state = await within(row).findByText('sleeping');

  expect(state).toBeInTheDocument();
  expect(stub.state.calls).toStrictEqual([{ path: 'imps.sleep', input: { name: 'web' } }]);
});

test('it asks before destroying an imp', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  const rendered = renderApp(stub);

  const row = await rendered.findByRole('row', { name: /web/ });

  await user.click(within(row).getByRole('button', { name: 'Destroy' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Destroy web?' });

  expect(dialog).toBeInTheDocument();
  expect(stub.state.calls).toStrictEqual([]);
});

test('it destroys an imp once the destroy is confirmed', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  const rendered = renderApp(stub);

  const row = await rendered.findByRole('row', { name: /web/ });

  await user.click(within(row).getByRole('button', { name: 'Destroy' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Destroy web?' });

  await user.click(within(dialog).getByRole('button', { name: 'Destroy' }));

  await waitFor(() => {
    expect(rendered.queryByRole('row', { name: /web/ })).toBeNull();
  });

  expect(stub.state.calls).toStrictEqual([{ path: 'imps.destroy', input: { name: 'web' } }]);
});

test('it sends only the fields that were filled in for a new imp', async () => {
  const stub = buildStubImpd();
  const user = userEvent.setup();
  const rendered = renderApp(stub);

  const button = await rendered.findByRole('button', { name: 'New imp' });

  await user.click(button);

  const dialog = await rendered.findByRole('dialog', { name: 'New imp' });

  await user.type(within(dialog).getByLabelText('Name'), 'box');
  await user.type(within(dialog).getByLabelText('Memory (MiB)'), '512');
  await user.click(within(dialog).getByRole('button', { name: 'Create' }));
  await rendered.findByRole('row', { name: /box/ });

  expect(stub.state.calls).toStrictEqual([
    { path: 'imps.create', input: { name: 'box', memoryMib: 512 } },
  ]);
});

test('it shows a change impd streams without waiting for the next poll', async () => {
  const stub = buildStubImpd();
  const imp = buildMockImp({ name: 'web', state: 'running' });

  stub.state.imps.push(imp);

  const rendered = renderApp(stub);

  const row = await rendered.findByRole('row', { name: /web/ });

  // impd sends its event only to streams open at the time
  await waitFor(() => {
    expect(stub.state.openStreams).toBe(1);
  });

  const event = buildMockImpChangedEvent({ reason: 'slept', imp: { ...imp, state: 'sleeping' } });

  stub.state.imps.splice(0, 1, event.imp);
  stub.emitEvent(event);

  const state = await within(row).findByText('sleeping');

  expect(state).toBeInTheDocument();
});
