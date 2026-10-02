import { expect, test } from 'bun:test';
import { screen } from '@testing-library/react';
import { buildImp, createFakeImpd } from '../test-utils/fake-impd';
import { renderApp } from '../test-utils/render-app';

test('it lists imps by the RAM they own, largest first', async () => {
  const fake = createFakeImpd();

  fake.state.imps.push(
    buildImp({ name: 'idle', state: 'sleeping' }),
    buildImp({ name: 'small', ramMib: 100, rssMib: 150 }),
    buildImp({ name: 'big', ramMib: 900, rssMib: 1000 }),
  );

  renderApp(fake, '/ram');

  await screen.findByRole('row', { name: /big/ });

  const names = screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('a')?.textContent);

  expect(names).toEqual(['big', 'small', 'idle']);
  expect(screen.getByRole('row', { name: /small/ })).toHaveTextContent('100 MiB150 MiB2.0 GiB');
  expect(screen.getByRole('meter', { name: 'RAM in use' })).toBeInTheDocument();
});
