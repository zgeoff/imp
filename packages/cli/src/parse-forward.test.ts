import { expect, test } from 'bun:test';
import { parseForward } from './parse-forward';
import { UsageError } from './usage-error';

test.each([
  ['5432', 5432, 5432],
  ['3001:3000', 3001, 3000],
  ['0:80', 0, 80],
])('it reads %p as local port %p to remote port %p', (spec, local, remote) => {
  expect(parseForward(spec)).toStrictEqual({ local, remote });
});

test.each(['0', '65536', '1:70000', 'http', '1:2:3', ':80', '80:', '-1'])(
  'it rejects %p as a usage error',
  (spec) => {
    expect(() => parseForward(spec)).toThrowWithMessage(
      UsageError,
      `not a port: ${spec} (try 5432, or local:remote such as 15432:5432)`,
    );
  },
);
