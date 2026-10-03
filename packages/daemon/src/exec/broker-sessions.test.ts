import { expect, test } from 'bun:test';
import { createBrokerSessions } from './broker-sessions';

test('an attach that requires the broker passes only to a session of this boot started with it', () => {
  const sessions = createBrokerSessions();

  expect(sessions.note('imp-1', 'main', true, 'boot-1')).toBeNull();
  expect(sessions.note('imp-1', 'main', false, 'boot-1')).toBeNull();

  // another boot: the session from before is gone with it
  expect(sessions.note('imp-1', 'main', false, 'boot-2')).not.toBeNull();

  // an attach that does not require the broker is never refused
  expect(sessions.note('imp-1', 'other', false, null)).toBeNull();
});

test('a session started again without the requirement drops it', () => {
  const sessions = createBrokerSessions();

  sessions.note('imp-1', 'main', true, 'boot-1');
  sessions.note('imp-1', 'main', true, null);

  expect(sessions.note('imp-1', 'main', false, 'boot-1')?.message).toContain(
    'session main was started without the broker requirement',
  );
});
