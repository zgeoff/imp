import { expect, test } from 'bun:test';
import { isAgentSessionState } from './is-agent-session-state';

test.each([
  ['running', true],
  ['exited', true],
  ['paused', false],
  ['', false],
])('it reads the state %p as known: %p', (state, known) => {
  expect(isAgentSessionState(state)).toBe(known);
});
