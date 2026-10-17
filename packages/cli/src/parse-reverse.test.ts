import { expect, test } from 'bun:test';
import { UsageError } from './errors';
import { parseReverse } from './parse-reverse';
import type { ReverseSpec } from './parse-reverse';

test.each<[string, ReverseSpec]>([
  [
    '/tmp/atc.sock:/Users/me/.atc/atc.sock',
    {
      guest: { network: 'unix', path: '/tmp/atc.sock' },
      local: { network: 'unix', path: '/Users/me/.atc/atc.sock' },
    },
  ],
  ['9000:8080', { guest: { network: 'tcp', port: 9000 }, local: { network: 'tcp', port: 8080 } }],
  ['9000', { guest: { network: 'tcp', port: 9000 }, local: { network: 'tcp', port: 9000 } }],
  [
    '0:/run/app.sock',
    { guest: { network: 'tcp', port: 0 }, local: { network: 'unix', path: '/run/app.sock' } },
  ],
  [
    ':/tmp/a:b.sock',
    { guest: { network: 'unix', path: null }, local: { network: 'unix', path: '/tmp/a:b.sock' } },
  ],
])('#parseReverse reads %p as its guest and local sides', (spec, sides) => {
  expect(parseReverse(spec)).toStrictEqual(sides);
});

test.each(['', 'app.sock:/x', '70000:80', '9000:0', '9000:host:80', 'x', '/a.sock:rel'])(
  '#parseReverse rejects %p as a usage error',
  (spec) => {
    expect(() => parseReverse(spec)).toThrowWithMessage(
      UsageError,
      `not a reverse forward: ${spec} (try GUEST:LOCAL, each an absolute path or a port: /tmp/app.sock:/run/app.sock, 9000:8080, or 9000)`,
    );
  },
);
