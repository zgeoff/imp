import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { buildStubDockerCli } from '../test-utils/build-stub-docker-cli';
import { assertUnpacked, readSetfcapWarning, writeExportedTree } from './unpack-export';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-unpack-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

// GNU tar 1.35 exits 0 when it runs without CAP_SETFCAP, and prints this
test('#assertUnpacked fails an unpack whose capability tar had no permission to set and names SETFCAP', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: some/file: time stamp in the future\ntar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted\n",
    });
  }).toThrow(
    expect.objectContaining({
      code: 'PRECONDITION_FAILED',
      message:
        "the image has a file capability that impd could not keep (tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted); imp-host needs CAP_SETFCAP (docs/architecture/host-contract.md#privileges)",
    }),
  );
});

// a namespaced (v3) capability whose root the host does not map
test.each([
  [
    "tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Invalid argument",
  ],
  [
    "tar: setxattrat: Cannot set 'user.mime_type' extended attribute for file 'srv/a': Operation not supported",
  ],
])(
  '#assertUnpacked fails an unpack with the line of another attribute tar could not set: %s',
  (line) => {
    expect(() => {
      assertUnpacked({ exitCode: 0, stdout: '', stderr: `${line}\n` });
    }).toThrow(
      expect.objectContaining({
        code: 'INTERNAL_SERVER_ERROR',
        message: `the image has an extended attribute that impd could not keep: ${line}`,
      }),
    );
  },
);

test('#assertUnpacked blames SETFCAP when its line comes after another attribute failure', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: setxattrat: Cannot set 'user.x' extended attribute for file 'srv/a': Operation not supported\ntar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted\n",
    });
  }).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
});

test('#assertUnpacked passes a warning that only names a file called security.capability', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr: 'tar: srv/security.capability: time stamp 2030-01-01 is in the future\n',
    });
  }).not.toThrow();
});

test('#assertUnpacked reads the attribute name, not the file name, of a failed attribute', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: setxattrat: Cannot set 'user.x' extended attribute for file 'srv/security.capability': Operation not permitted\n",
    });
  }).toThrow(expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR' }));
});

test('#assertUnpacked passes an unpack with no warning', () => {
  expect(() => {
    assertUnpacked({ exitCode: 0, stdout: '', stderr: '' });
  }).not.toThrow();
});

test('#assertUnpacked fails an unpack whose tar exited non-zero with its stderr', () => {
  expect(() => {
    assertUnpacked({ exitCode: 2, stdout: '', stderr: 'tar: Unexpected EOF in archive' });
  }).toThrowWithMessage(Error, 'docker export | tar exited 2: tar: Unexpected EOF in archive');
});

// the export is impd's own call on its own container: nothing in it came
// from the client, so a refusal of it is impd's error, never BAD_REQUEST
test('#assertUnpacked keeps an export the proxy refused as impd’s own error, with no code', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 1,
      stdout: '',
      stderr:
        'Error response from daemon: imp-docker-proxy: GET /containers/x/export is not a call impd makes\n',
    });
  }).toThrow(expect.not.objectContaining({ code: expect.anything() as unknown }));
});

test('#assertUnpacked names the proxy refusal of an export in its error', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 1,
      stdout: '',
      stderr:
        'Error response from daemon: imp-docker-proxy: GET /containers/x/export is not a call impd makes\n',
    });
  }).toThrowWithMessage(
    Error,
    'docker export | tar exited 1: Error response from daemon: imp-docker-proxy: GET /containers/x/export is not a call impd makes',
  );
});

// imp-host's set from deploy/imp-host.args.json, with bit 31
test('#readSetfcapWarning gives no start warning when CapEff holds CAP_SETFCAP', () => {
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000882810fb\n')).toBeNull();
});

test('#readSetfcapWarning gives the start warning when CapEff lacks CAP_SETFCAP', () => {
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000082810fb\n')).toBe(
    'impd: warning: no CAP_SETFCAP, so an image add or build fails on an image with a file capability; imp-host needs CAP_SETFCAP (docs/architecture/host-contract.md#privileges)',
  );
});

test('#writeExportedTree unpacks the container export into the root', async () => {
  const ctx = await setupTest();

  const tree = join(ctx.dir, 'tree');
  const root = join(ctx.dir, 'root');

  mkdirSync(join(tree, 'etc'), { recursive: true });
  mkdirSync(root);
  writeFileSync(join(tree, 'etc', 'hostname'), 'imp\n');

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    exportTar: Bun.spawnSync(['tar', '-C', tree, '-c', 'etc']).stdout,
  });

  updateEnv('PATH', docker.path);

  await writeExportedTree('c'.repeat(64), root);

  expect(readFileSync(join(root, 'etc', 'hostname'), 'utf8')).toBe('imp\n');
});

test('#writeExportedTree fails the unpack when the export fails', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir });

  updateEnv('PATH', docker.path);

  // pipefail reports tar's exit, which the empty export fails
  expect(writeExportedTree('c'.repeat(64), ctx.dir)).rejects.toThrowWithMessage(
    Error,
    /^docker export \| tar exited 2: stub docker: export c{64} is not modelled\n/v,
  );
});
