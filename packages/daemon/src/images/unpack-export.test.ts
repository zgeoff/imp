import { expect, test } from 'bun:test';
import { assertUnpacked, findLostCapability, readSetfcapWarning } from './unpack-export';

// GNU tar 1.35's line when it runs without CAP_SETFCAP; it still exits 0
const LOST =
  "tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted";

test('a capability tar could not set fails the unpack and names SETFCAP', () => {
  const failure = (() => {
    try {
      assertUnpacked({ exitCode: 0, stdout: '', stderr: `${LOST}\n` });
    } catch (error) {
      return error;
    }

    return null;
  })();

  expect(failure).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(String(failure)).toContain('CAP_SETFCAP');
  expect(String(failure)).toContain('usr/bin/ping');
});

test('an unpack with no lost capability passes, and a failed tar still throws', () => {
  expect(() => {
    assertUnpacked({ exitCode: 0, stdout: '', stderr: '' });
  }).not.toThrow();

  expect(() => {
    assertUnpacked({
      exitCode: 2,
      stdout: '',
      stderr: 'tar: Unexpected EOF in archive',
    });
  }).toThrow('exited 2: tar: Unexpected EOF in archive');
});

test('only a line about security.capability counts as a lost capability', () => {
  expect(findLostCapability(`tar: some/file: time stamp in the future\n${LOST}\n`)).toBe(LOST);
  expect(findLostCapability('tar: some/file: time stamp in the future\n')).toBeNull();
});

test('the start warning shows only when CapEff lacks CAP_SETFCAP', () => {
  // imp-host's set from deploy/imp-host.args.json, with and without bit 31
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000882810fb\n')).toBeNull();
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000082810fb\n')).toContain('CAP_SETFCAP');
});
