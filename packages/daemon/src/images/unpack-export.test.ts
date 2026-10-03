import { expect, test } from 'bun:test';
import { assertUnpacked, readSetfcapWarning } from './unpack-export';

// GNU tar 1.35's line when it runs without CAP_SETFCAP; it still exits 0
const LOST =
  "tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted";

// what assertUnpacked threw, or null
function readUnpackFailure(stderr: string): unknown {
  try {
    assertUnpacked({ exitCode: 0, stdout: '', stderr });
  } catch (error) {
    return error;
  }

  return null;
}

test('a capability tar had no permission to set fails the unpack and names SETFCAP', () => {
  const failure = readUnpackFailure(`tar: some/file: time stamp in the future\n${LOST}\n`);

  expect(failure).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(String(failure)).toContain('CAP_SETFCAP');
  expect(String(failure)).toContain('usr/bin/ping');
});

test('any other attribute tar could not set fails with its line, and does not blame SETFCAP', () => {
  // a namespaced (v3) capability whose root the host does not map
  const invalid =
    "tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Invalid argument";

  const userAttr =
    "tar: setxattrat: Cannot set 'user.mime_type' extended attribute for file 'srv/a': Operation not supported";

  for (const line of [invalid, userAttr]) {
    const failure = readUnpackFailure(`${line}\n`);

    expect(failure).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(String(failure)).toContain(line);
    expect(String(failure)).not.toContain('SETFCAP');
  }
});

test('the SETFCAP line wins over another failure, and a file name is not an attribute', () => {
  const userAttr =
    "tar: setxattrat: Cannot set 'user.x' extended attribute for file 'srv/a': Operation not supported";

  expect(readUnpackFailure(`${userAttr}\n${LOST}\n`)).toMatchObject({
    code: 'PRECONDITION_FAILED',
  });

  expect(
    readUnpackFailure('tar: srv/security.capability: time stamp 2030-01-01 is in the future\n'),
  ).toBeNull();

  expect(
    readUnpackFailure(
      "tar: setxattrat: Cannot set 'user.x' extended attribute for file 'srv/security.capability': Operation not permitted\n",
    ),
  ).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
});

test('an unpack with no warning passes, and a failed tar still throws', () => {
  expect(readUnpackFailure('')).toBeNull();

  expect(() => {
    assertUnpacked({ exitCode: 2, stdout: '', stderr: 'tar: Unexpected EOF in archive' });
  }).toThrow('exited 2: tar: Unexpected EOF in archive');
});

test('the start warning shows only when CapEff lacks CAP_SETFCAP', () => {
  // imp-host's set from deploy/imp-host.args.json, with and without bit 31
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000882810fb\n')).toBeNull();
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000082810fb\n')).toContain('CAP_SETFCAP');
});

test('an export the proxy refused is the client’s BAD_REQUEST, with the proxy’s message alone', () => {
  const refusal = 'imp-docker-proxy: GET /containers/x/export is not a call impd makes';
  const stderr = `Error response from daemon: ${JSON.stringify({ message: refusal })}\n`;

  expect(() => {
    assertUnpacked({ exitCode: 1, stdout: '', stderr });
  }).toThrow(expect.objectContaining({ code: 'BAD_REQUEST', message: refusal }));

  expect(() => {
    assertUnpacked({ exitCode: 1, stdout: '', stderr: 'tar: short read' });
  }).toThrow('docker export | tar exited 1: tar: short read');
});
