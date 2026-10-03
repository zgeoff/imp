import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { OAuthApproval } from '@imp/api';
import { UsageError } from '../usage-error';
import { runApprove } from './oauth';

const APPROVAL: OAuthApproval = {
  client: 'conn',
  redirectUri: 'https://client.example/callback',
  requestedScope: 'exec',
  requestedAt: new Date('2026-10-04T10:00:00.000Z'),
  expiresAt: new Date('2026-10-04T10:10:00.000Z'),
};

const REQUEST = { code: 'ABCDEFGH', scope: 'exec' as const, imps: ['dev-*'], isConfirmed: false };

afterEach(() => {
  mock.restore();
});

// an impd that records the approvals calls, and a prompt that answers
function setupTest(isTerminal: boolean, answer: boolean) {
  const calls: string[] = [];
  const questions: string[] = [];
  const approved: unknown[] = [];

  const stderr = spyOn(console, 'error').mockImplementation(() => {
    // captured
  });

  const client = {
    oauth: {
      approvals: {
        get: () => {
          calls.push('get');

          return Promise.resolve(APPROVAL);
        },
        approve: (input: unknown) => {
          calls.push('approve');
          approved.push(input);

          return Promise.resolve({});
        },
      },
    },
  };

  const prompt = {
    isTerminal,
    confirm: (question: string) => {
      questions.push(question);

      return Promise.resolve(answer);
    },
  };

  return { calls, questions, approved, stderr, client, prompt };
}

// the failure runApprove ended with, or null
async function readFailure(run: Promise<void>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }

  return null;
}

test('with no terminal and no --yes, it refuses before it calls impd', async () => {
  const ctx = setupTest(false, true);

  const failure = await readFailure(runApprove(ctx.client, REQUEST, ctx.prompt));

  expect(failure).toBeInstanceOf(UsageError);
  expect(String(failure)).toContain('pass --yes');
  expect(ctx.calls).toEqual([]);
});

test('at a terminal it shows the sign-in, asks, and a no approves nothing', async () => {
  const ctx = setupTest(true, false);

  const failure = await readFailure(runApprove(ctx.client, REQUEST, ctx.prompt));

  expect(String(failure)).toContain('not approved; nothing changed');
  expect(ctx.calls).toEqual(['get']);
  expect(ctx.questions).toEqual(['Approve this sign-in? [y/N] ']);

  expect(ctx.stderr).toHaveBeenCalledWith(
    expect.stringContaining('returns to:   https://client.example/callback'),
  );

  expect(ctx.stderr).toHaveBeenCalledWith('it gets:      exec on dev-*');
});

test('at a terminal a yes approves what was shown', async () => {
  const ctx = setupTest(true, true);

  await runApprove(ctx.client, REQUEST, ctx.prompt);

  expect(ctx.calls).toEqual(['get', 'approve']);
  expect(ctx.approved).toEqual([{ code: 'ABCDEFGH', scope: 'exec', imps: ['dev-*'] }]);
});

test('--yes approves without asking, with or without a terminal', async () => {
  for (const isTerminal of [false, true]) {
    const ctx = setupTest(isTerminal, false);

    await runApprove(ctx.client, { ...REQUEST, isConfirmed: true }, ctx.prompt);

    expect(ctx.calls).toEqual(['get', 'approve']);
    expect(ctx.questions).toEqual([]);

    mock.restore();
  }
});
