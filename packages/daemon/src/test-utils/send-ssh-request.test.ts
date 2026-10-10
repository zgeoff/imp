import { expect, test } from 'bun:test';
import { sendSshRequest } from './send-ssh-request';

test('it resolves with the values a request answers after no failure', () => {
  const settled = sendSshRequest<[number]>((done) => {
    done(undefined, 40_001);
  });

  expect(settled).resolves.toStrictEqual([40_001]);
});

test('it resolves with no values for a request that answers only a null failure', () => {
  const settled = sendSshRequest((done) => {
    done(null);
  });

  expect(settled).resolves.toStrictEqual([]);
});

test('it rejects with the failure a request answers', () => {
  const settled = sendSshRequest<[number]>((done) => {
    done(new Error('Unable to bind to 10.0.0.5:8000'), 0);
  });

  expect(settled).rejects.toThrowWithMessage(Error, 'Unable to bind to 10.0.0.5:8000');
});
