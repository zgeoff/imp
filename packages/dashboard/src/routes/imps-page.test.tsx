import { expect, test } from 'bun:test';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildImp, createFakeImpd } from '../test-utils/fake-impd';
import { renderApp } from '../test-utils/render-app';

test('it lists every imp with its state, RAM and notes', async () => {
  const fake = createFakeImpd();

  fake.state.imps.push(
    buildImp({ name: 'web', ramMib: 300 }),
    buildImp({
      name: 'old',
      state: 'sleeping',
      coldBootReason: 'the kernel changed',
      memoryMib: 512,
    }),
    buildImp({ name: 'bad', state: 'error', error: 'boot failed: no agent' }),
  );

  renderApp(fake);

  const web = await screen.findByRole('row', { name: /web/ });

  expect(within(web).getByText('running')).toBeInTheDocument();
  expect(within(web).getByText(/300 MiB/)).toBeInTheDocument();
  expect(within(web).getByRole('button', { name: 'Sleep' })).toBeInTheDocument();

  const old = screen.getByRole('row', { name: /old/ });

  expect(within(old).getByText('next wake boots cold: the kernel changed')).toBeInTheDocument();
  expect(within(old).getByRole('button', { name: 'Wake' })).toBeInTheDocument();

  const bad = screen.getByRole('row', { name: /bad/ });

  expect(within(bad).getByText('boot failed: no agent')).toBeInTheDocument();
  expect(within(bad).getByRole('button', { name: 'Restart' })).toBeInTheDocument();
});

test('it shows the RAM budget from system.info', async () => {
  const fake = createFakeImpd();

  renderApp(fake);

  const meter = await screen.findByRole('meter', { name: 'RAM in use' });

  expect(meter).toHaveAttribute('aria-valuenow', '1024');
  expect(screen.getByText('1.0 GiB of 4.0 GiB')).toBeInTheDocument();
  expect(screen.getByText('No imps yet. Make one with New imp.')).toBeInTheDocument();
});

test('a lifecycle button calls impd and the row follows', async () => {
  const fake = createFakeImpd();
  const user = userEvent.setup();

  fake.state.imps.push(buildImp({ name: 'web' }));

  renderApp(fake);

  const row = await screen.findByRole('row', { name: /web/ });

  await user.click(within(row).getByRole('button', { name: 'Sleep' }));

  await waitFor(() => {
    expect(within(row).getByText('sleeping')).toBeInTheDocument();
  });

  expect(fake.state.calls).toEqual([{ path: 'imps.sleep', input: { name: 'web' } }]);
});

test('destroy asks first and calls impd only on confirm', async () => {
  const fake = createFakeImpd();
  const user = userEvent.setup();

  fake.state.imps.push(buildImp({ name: 'web' }));

  renderApp(fake);

  const row = await screen.findByRole('row', { name: /web/ });

  await user.click(within(row).getByRole('button', { name: 'Destroy' }));

  const dialog = await screen.findByRole('dialog', { name: 'Destroy web?' });

  expect(fake.state.calls).toEqual([]);

  await user.click(within(dialog).getByRole('button', { name: 'Destroy' }));

  await waitFor(() => {
    expect(screen.queryByRole('row', { name: /web/ })).not.toBeInTheDocument();
  });

  expect(fake.state.calls).toEqual([{ path: 'imps.destroy', input: { name: 'web' } }]);
});

test('a new imp sends only the fields that were filled in', async () => {
  const fake = createFakeImpd();
  const user = userEvent.setup();

  renderApp(fake);

  const button = await screen.findByRole('button', { name: 'New imp' });

  await user.click(button);

  const dialog = await screen.findByRole('dialog', { name: 'New imp' });

  await user.type(within(dialog).getByLabelText('Name'), 'box');
  await user.type(within(dialog).getByLabelText('Memory (MiB)'), '512');
  await user.click(within(dialog).getByRole('button', { name: 'Create' }));
  await screen.findByRole('row', { name: /box/ });

  expect(fake.state.calls).toEqual([
    { path: 'imps.create', input: { name: 'box', memoryMib: 512 } },
  ]);
});
