import { expect, test } from 'bun:test';
import { writeDnsName, writeDnsUint16 } from './write-dns-wire';

test('#writeDnsName writes each label after its length, and a zero byte last', () => {
  expect(writeDnsName('a.test')).toStrictEqual([1, 0x61, 4, 0x74, 0x65, 0x73, 0x74, 0]);
});

test('#writeDnsName writes a trailing dot as the root it already ends in', () => {
  expect(writeDnsName('a.test.')).toStrictEqual([1, 0x61, 4, 0x74, 0x65, 0x73, 0x74, 0]);
});

test('#writeDnsUint16 writes the high byte first', () => {
  expect(writeDnsUint16(0x12_34)).toStrictEqual([0x12, 0x34]);
});
