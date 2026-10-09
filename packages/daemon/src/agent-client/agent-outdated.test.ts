import { expect, test } from 'bun:test';
import { AgentError } from './agent-connection';
import {
  buildAgentOutdatedError,
  buildAgentUnknownError,
  handleUnknownOp,
  hasFeature,
} from './agent-outdated';

test.each([
  ['0.1.0', false],
  ['0.1.9', false],
  ['0.2.0', true],
  ['0.2.5', true],
  ['0.10.1', true],
  ['1.0.0', true],
])('#hasFeature gives agent %s sessions: %p', (version, expected) => {
  expect(hasFeature(version, 'sessions')).toBe(expected);
});

test.each([
  ['0.2.5', false],
  ['0.3.0', true],
  ['0.10.1', true],
  ['1.0.0', true],
])('#hasFeature gives agent %s dial and sftp: %p', (version, expected) => {
  expect(hasFeature(version, 'ssh')).toBe(expected);
});

// the agent's own answer settles a feature that is not strict
test.each([['dev'], ['']])(
  '#hasFeature passes a feature that is not strict for the version %p, which does not parse',
  (version) => {
    expect(hasFeature(version, 'sessions')).toBe(true);
  },
);

test('#hasFeature passes a feature that is not strict for an agent with no recorded version', () => {
  expect(hasFeature(undefined, 'sessions')).toBe(true);
});

test.each([
  ['0.15.9', false],
  ['0.16.0', true],
  ['0.17.1', true],
  ['1.0.0', true],
])('#hasFeature gives agent %s an outer exec: %p', (version, expected) => {
  expect(hasFeature(version, 'outer-exec')).toBe(expected);
});

test.each([['dev'], ['']])(
  '#hasFeature fails the strict outer exec for the version %p, which does not parse',
  (version) => {
    expect(hasFeature(version, 'outer-exec')).toBe(false);
  },
);

test('#hasFeature fails the strict outer exec for an agent with no recorded version', () => {
  expect(hasFeature(undefined, 'outer-exec')).toBe(false);
});

test.each([
  ['0.16.9', false],
  ['0.17.0', true],
  ['1.0.0', true],
])('#hasFeature gives agent %s elastic memory: %p', (version, expected) => {
  expect(hasFeature(version, 'elastic-memory')).toBe(expected);
});

test('#hasFeature fails the strict elastic memory for an agent with no recorded version', () => {
  expect(hasFeature(undefined, 'elastic-memory')).toBe(false);
});

test('#buildAgentOutdatedError tells the user to stop and start the imp', () => {
  const error = buildAgentOutdatedError('ssh');

  expect(error).toBeInstanceOf(AgentError);
  expect(error.code).toBe('AGENT_OUTDATED');

  expect(error.detail).toBe(
    "the imp's agent has no port forwarding or SFTP yet; stop and start the imp to update it",
  );
});

test('#buildAgentUnknownError tells the user to stop and start the imp to record its version', () => {
  const error = buildAgentUnknownError('outer-exec');

  expect(error).toBeInstanceOf(AgentError);
  expect(error.code).toBe('AGENT_OUTDATED');

  expect(error.detail).toBe(
    "impd has no record of the imp's agent version, so it takes it to have no exec --agent; stop and start the imp to record it",
  );
});

test("#handleUnknownOp turns the agent's UNKNOWN_OP into AGENT_OUTDATED for the feature", () => {
  const handle = handleUnknownOp('grow');

  expect(() => handle(new AgentError('UNKNOWN_OP', 'unknown op grow'))).toThrowWithMessage(
    AgentError,
    "AGENT_OUTDATED: the imp's agent has no online disk grow yet; stop and start the imp to update it",
  );
});

test('#handleUnknownOp rethrows any other agent error as it came', () => {
  const handle = handleUnknownOp('sessions');

  expect(() => handle(new AgentError('NO_SESSION', 'no session "main"'))).toThrowWithMessage(
    AgentError,
    'NO_SESSION: no session "main"',
  );
});

test('#handleUnknownOp rethrows an error that does not come from the agent', () => {
  const handle = handleUnknownOp('sessions');

  expect(() => handle(new Error('socket hang up'))).toThrowWithMessage(Error, 'socket hang up');
});
