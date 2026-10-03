// Values a hostile agent can send for each id impd makes a log from. Every
// one must fail its schema before impd touches the disk.

const HEX = 'a'.repeat(32);
const UUID = '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11';

// separators, traversal, absolute paths, NUL, empty and over-long values
const PATH_ATTACKS = [
  '/',
  '\\',
  'a/b',
  String.raw`a\b`,
  '..',
  '.',
  '../../../evil',
  String.raw`..\..\evil`,
  '/etc/passwd',
  String.raw`C:\evil`,
  '\0',
  'a\0b',
  'x'.repeat(4096),
];

export const HOSTILE_GENERATIONS = [
  ...PATH_ATTACKS,
  '',
  `${HEX.slice(1)}/`,
  `${HEX.slice(1)}\\`,
  `${HEX.slice(0, 16)}/../${HEX.slice(0, 13)}`,
  `/${HEX.slice(1)}`,
  `${HEX.slice(1)}\0`,
  HEX.slice(1),
  `${HEX}a`,
  'A'.repeat(32),
  'g'.repeat(32),
  UUID,
];

// an empty boot id is the real agent's answer without procfs, and is valid
export const HOSTILE_BOOT_IDS = [
  ...PATH_ATTACKS,
  `${UUID.slice(0, -1)}/`,
  `${UUID.slice(0, -1)}\\`,
  `../${UUID.slice(3)}`,
  `${UUID}\0`,
  UUID.slice(1),
  `${UUID}0`,
  UUID.toUpperCase(),
  UUID.replace('f', 'g'),
  UUID.replaceAll('-', ''),
];

export const HOSTILE_SESSION_NAMES = [
  ...PATH_ATTACKS,
  '',
  'main/..',
  String.raw`main\x`,
  'main\0',
  'a'.repeat(33),
  'Main',
  '-main',
  'main.log',
];
