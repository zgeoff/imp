import { expect, test } from 'bun:test';
import { parseForward } from './parse-forward';

test('a port forwards to the same port, and local:remote maps one to another', () => {
  expect(parseForward('5432')).toEqual({ local: 5432, remote: 5432 });
  expect(parseForward('3001:3000')).toEqual({ local: 3001, remote: 3000 });
  expect(parseForward('0:80')).toEqual({ local: 0, remote: 80 });
});

test('a port outside 1 to 65535, or not a number, is a usage error', () => {
  for (const spec of ['0', '65536', '1:70000', 'http', '1:2:3', ':80', '80:', '-1']) {
    expect(() => parseForward(spec)).toThrow(`not a port: ${spec}`);
  }
});
