import { expect, test } from 'bun:test';
import { createLogouts } from './logouts';

test('#readSignal gives a live signal before any logout', () => {
  const logouts = createLogouts();

  expect(logouts.readSignal().aborted).toBeFalse();
});

test('#logOut aborts the signal every dashboard stream holds', () => {
  const logouts = createLogouts();
  const stream = logouts.readSignal();

  logouts.logOut();

  expect(stream.aborted).toBeTrue();
});

test('#logOut leaves a live signal for a stream that reconnects after it', () => {
  const logouts = createLogouts();

  logouts.logOut();

  expect(logouts.readSignal().aborted).toBeFalse();
});
