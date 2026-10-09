import { expect, test } from 'bun:test';
import { createRangeChecker } from './range-checker';

test.each([
  ['10.1.2.3', 'in an IPv4 CIDR', true],
  ['8.8.4.4', 'an IPv4 address listed alone', true],
  ['::ffff:93.184.215.14', 'in the mapped IPv6 range', true],
  ['fd00::1', 'in an IPv6 CIDR', true],
  ['93.184.215.14', 'an IPv4 address the mapped IPv6 range holds', false],
  ['8.8.8.8', 'an IPv4 address outside every range', false],
  ['2606:4700::1111', 'an IPv6 address outside every range', false],
  ['example.com', 'a name', false],
])('it reads %s, %s, as in the ranges: %p', (address, _label, isIn) => {
  // ::ffff:0:0/96 holds every IPv4 address in mapped form; a shared list
  // would refuse them all
  const isInRanges = createRangeChecker(['10.0.0.0/8', '8.8.4.4'], ['::ffff:0:0/96', 'fc00::/7']);

  expect(isInRanges(address)).toBe(isIn);
});
