import { expect, test } from 'bun:test';
import {
  findLowMib,
  findRegionMib,
  findSpareTotalMib,
  findStructPageMib,
  resolveMaxMemoryMib,
  toWholeBlocks,
} from './elastic-memory';

test.each([
  ['an imp that does not grow', 512, 512, 0],
  ['growth of exactly one slot', 512, 640, 128],
  ['growth past a slot, rounded up to whole slots', 512, 700, 256],
])('#findRegionMib gives %s its region', (_label, memoryMib, maxMemoryMib, regionMib) => {
  expect(findRegionMib(memoryMib, maxMemoryMib)).toBe(regionMib);
});

test.each([
  ['128 MiB for a small guest', 512, 128],
  ['15 % of a large guest', 2000, 300],
])('#findLowMib sets the grow mark at %s', (_label, totalMib, lowMib) => {
  expect(findLowMib(totalMib)).toBe(lowMib);
});

test('#findSpareTotalMib leaves a small guest a step more than 128 MiB free', () => {
  expect(findSpareTotalMib(200)).toBe(200 + 128 + 256);
});

test('#findSpareTotalMib leaves a large guest a step more than 15 % of it free', () => {
  expect(findSpareTotalMib(2000)).toBe(Math.ceil((2000 + 256) / 0.85));
});

test('#findStructPageMib costs 16 MiB of struct pages per GiB plugged, rounded up', () => {
  expect(findStructPageMib(3072)).toBe(48);
});

test('#toWholeBlocks rounds up to whole 2 MiB blocks', () => {
  expect(toWholeBlocks(1033)).toBe(1034);
});

test('#resolveMaxMemoryMib gives an imp that asks for no max its memory', () => {
  expect(resolveMaxMemoryMib(512, undefined)).toBe(512);
});

test('#resolveMaxMemoryMib takes a max up to 4 times the memory', () => {
  expect(resolveMaxMemoryMib(512, 2048)).toBe(2048);
});

test('#resolveMaxMemoryMib refuses a max below the memory', () => {
  expect(() => resolveMaxMemoryMib(512, 256)).toThrow(
    'the max memory (256 MiB) is less than the memory (512 MiB)',
  );
});

test('#resolveMaxMemoryMib refuses a max past 4 times the memory as a bad request', () => {
  expect(() => resolveMaxMemoryMib(512, 2050)).toThrow(
    expect.objectContaining({ code: 'BAD_REQUEST' }),
  );
});

test('#resolveMaxMemoryMib says to raise the memory with a max past 4 times it', () => {
  expect(() => resolveMaxMemoryMib(512, 2050)).toThrow(
    'the max memory (2050 MiB) is more than 4 × the memory (2048 MiB)',
  );
});
