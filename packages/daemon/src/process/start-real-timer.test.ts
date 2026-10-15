import { expect, mock, test } from 'bun:test';
import { waitFor } from '@impz/test-utils/wait-for';
import { startRealTimer } from './start-real-timer';

test('it fires once after the delay', async () => {
  const fire = mock((): void => {});

  startRealTimer(fire, 1);

  await waitFor(() => {
    expect(fire).toHaveBeenCalledOnce();
  });
});

test('it never fires once cancelled', async () => {
  const fire = mock((): void => {});
  const control = mock((): void => {});
  const cancel = startRealTimer(fire, 1);

  cancel();
  startRealTimer(control, 5);

  await waitFor(() => {
    expect(control).toHaveBeenCalledOnce();
  });

  expect(fire).not.toHaveBeenCalled();
});

test('it still fires when it lets the process exit', async () => {
  const fire = mock((): void => {});

  startRealTimer(fire, 1, { isUnref: true });

  await waitFor(() => {
    expect(fire).toHaveBeenCalledOnce();
  });
});
