import { expect, test } from 'bun:test';
import { createRangeChecker } from './range-checker';

test('each family is checked against its own ranges only', () => {
  // ::ffff:0:0/96 holds every IPv4 address in mapped form; a shared list
  // would refuse them all
  const isIn = createRangeChecker(['10.0.0.0/8', '8.8.4.4'], ['::ffff:0:0/96', 'fc00::/7']);
  const inside = ['10.1.2.3', '8.8.4.4', '::ffff:93.184.215.14', 'fd00::1'];
  const outside = ['93.184.215.14', '8.8.8.8', '2606:4700::1111', 'example.com'];

  expect(inside.map((address) => isIn(address))).toEqual([true, true, true, true]);
  expect(outside.map((address) => isIn(address))).toEqual([false, false, false, false]);
});
