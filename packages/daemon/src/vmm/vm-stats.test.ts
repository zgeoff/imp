import { expect, test } from 'bun:test';
import { parseSmapsRollup } from './vm-stats';

test('it reads the kB fields of smaps_rollup', () => {
  const text = [
    '7f0000000000-7fffffffffff ---p 00000000 00:00 0                          [rollup]',
    'Rss:              349184 kB',
    'Pss_Anon:          15360 kB',
    'Private_Dirty:     15400 kB',
    'THPeligible:    0',
  ].join('\n');

  const fields = parseSmapsRollup(text);

  expect(fields.get('Rss')).toBe(349_184);
  expect(fields.get('Pss_Anon')).toBe(15_360);
  expect(fields.has('THPeligible')).toBe(false);
});
