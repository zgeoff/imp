import { expect, mock, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { impCollection } from '../mocks/db/imp-collection';
import { sessionCollection } from '../mocks/db/session-collection';
import { systemInfoCollection } from '../mocks/db/system-info-collection';
import { RPC_URL } from '../mocks/handlers';
import { emitImpdEvent, impdEventListeners } from '../mocks/impd-events';
import { server } from '../mocks/node';
import { buildMockImpChangedEvent } from '../test-utils/build-mock-imp-changed-event';
import { readRpcInput } from '../test-utils/read-rpc-input';
import { renderApp } from '../test-utils/render-app';

test('it lists a running imp with its state, RAM, disk and a sleep button', async () => {
  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'running', ramMib: 300, diskMib: 32_768 });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/ });

  expect(within(row).getByText('running')).toBeInTheDocument();
  expect(within(row).getByText(/300 MiB/)).toBeInTheDocument();
  expect(within(row).getByText('— / 32.0 GiB')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Sleep' })).toBeInTheDocument();
});

test('it lists a sleeping imp with its notes and a wake button', async () => {
  await sessionCollection.create({});

  await impCollection.create({
    name: 'old',
    state: 'sleeping',
    coldBootReason: 'the kernel changed',
  });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /old/ });

  expect(within(row).getByText('next wake boots cold: the kernel changed')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Wake' })).toBeInTheDocument();
});

test('it lists a failed imp with its error and a restart button', async () => {
  await sessionCollection.create({});
  await impCollection.create({ name: 'bad', state: 'error', error: 'boot failed: no agent' });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /bad/ });

  expect(within(row).getByText('boot failed: no agent')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Restart' })).toBeInTheDocument();
});

test('it shows the RAM in use against the budget of the host', async () => {
  await sessionCollection.create({});
  await systemInfoCollection.create({ ramBudgetMib: 4096, ramUsedMib: 1024 });

  const rendered = renderApp();

  const meter = await rendered.findByRole('meter', { name: 'RAM in use' });

  expect(meter).toHaveAttribute('aria-valuenow', '1024');
  expect(rendered.getByText('1.0 GiB of 4.0 GiB')).toBeInTheDocument();
});

test('it invites a first imp when there are none', async () => {
  await sessionCollection.create({});

  const rendered = renderApp();

  const invite = await rendered.findByText('No imps yet. Make one with New imp.');

  expect(invite).toBeInTheDocument();
});

test('it moves the row of an imp to the state its lifecycle button asks for', async () => {
  const user = userEvent.setup();

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'running' });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/ });

  await user.click(within(row).getByRole('button', { name: 'Sleep' }));

  const state = await within(row).findByText('sleeping');

  expect(state).toBeInTheDocument();
  expect(impCollection.findFirst((query) => query.where({ name: 'web' }))?.state).toBe('sleeping');
});

test('it asks before destroying an imp', async () => {
  const user = userEvent.setup();

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/ });

  await user.click(within(row).getByRole('button', { name: 'Destroy' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Destroy web?' });

  expect(dialog).toBeInTheDocument();
  expect(impCollection.findMany().map((imp) => imp.name)).toStrictEqual(['web']);
});

test('it destroys an imp once the destroy is confirmed', async () => {
  const user = userEvent.setup();

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/ });

  await user.click(within(row).getByRole('button', { name: 'Destroy' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Destroy web?' });

  await user.click(within(dialog).getByRole('button', { name: 'Destroy' }));

  await waitFor(() => {
    expect(rendered.queryByRole('row', { name: /web/ })).toBeNull();
  });

  expect(impCollection.count()).toBe(0);
});

test('it sends only the fields that were filled in for a new imp', async () => {
  const user = userEvent.setup();
  const received = mock<(input: unknown) => void>();

  await sessionCollection.create({});

  server.use(
    http.post(`${RPC_URL}/imps/create`, async (info) => {
      const input = await readRpcInput(info.request);

      received(input);
    }),
  );

  const rendered = renderApp();

  const button = await rendered.findByRole('button', { name: 'New imp' });

  await user.click(button);

  const dialog = await rendered.findByRole('dialog', { name: 'New imp' });

  await user.type(within(dialog).getByLabelText('Name'), 'box');
  await user.type(within(dialog).getByLabelText('Memory (MiB)'), '512');
  await user.click(within(dialog).getByRole('button', { name: 'Create' }));
  await rendered.findByRole('row', { name: /box/ });

  expect(received).toHaveBeenCalledExactlyOnceWith({ name: 'box', memoryMib: 512 });
});

test('it shows a change impd streams without waiting for the next poll', async () => {
  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'running' });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/ });

  // impd sends its event only to streams open at the time
  await waitFor(() => {
    expect(impdEventListeners.size).toBe(1);
  });

  // a change made elsewhere, such as from the CLI
  const slept = await impCollection.update((query) => query.where({ name: 'web' }), {
    data(imp) {
      imp.state = 'sleeping';
    },
  });

  emitImpdEvent(buildMockImpChangedEvent({ reason: 'slept', imp: { ...slept } }));

  const state = await within(row).findByText('sleeping');

  expect(state).toBeInTheDocument();
});
