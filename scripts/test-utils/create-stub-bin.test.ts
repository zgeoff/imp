import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-stub-bin-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    dir,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it records each call with its arguments', () => {
  using ctx = setupTest();

  const stub = createStubBin(ctx.dir, 'docker');

  Bun.spawnSync(['docker', 'image', 'ls', '--format', '{{.ID}}'], {
    env: { PATH: `${stub.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(readFileSync(stub.calls, 'utf8')).toBe('docker image ls --format {{.ID}}\n');
});

test('it answers with the output and exit code of its script', () => {
  using ctx = setupTest();

  const stub = createStubBin(ctx.dir, 'gh', 'echo "attested $1"; echo warn >&2; exit 3');

  const result = Bun.spawnSync(['gh', 'attestation'], {
    env: { PATH: `${stub.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 3, stdout: 'attested attestation\n', stderr: 'warn\n' });
});

test('it exits 0 with no output when it has no script', () => {
  using ctx = setupTest();

  const stub = createStubBin(ctx.dir, 'systemctl');

  const result = Bun.spawnSync(['systemctl', 'daemon-reload'], {
    env: { PATH: `${stub.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it logs the calls of stubs that share a directory in the order they ran', () => {
  using ctx = setupTest();

  const docker = createStubBin(ctx.dir, 'docker');
  const systemctl = createStubBin(ctx.dir, 'systemctl');

  Bun.spawnSync(['bash', '-c', 'docker pull x; systemctl restart imp-host; docker ps'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(systemctl.calls).toBe(docker.calls);

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    'docker pull x\nsystemctl restart imp-host\ndocker ps\n',
  );
});

test('it starts with an empty log before any call', () => {
  using ctx = setupTest();

  const stub = createStubBin(ctx.dir, 'curl');

  expect(readFileSync(stub.calls, 'utf8')).toBe('');
});

test('it lets the script append its own lines to the log', () => {
  using ctx = setupTest();

  const stub = createStubBin(ctx.dir, 'docker', 'echo "saw IMP_X=$IMP_X" >>"$STUB_CALLS"');

  Bun.spawnSync(['docker', 'compose'], {
    env: { PATH: `${stub.bin}:${process.env['PATH'] ?? ''}`, IMP_X: '1' },
  });

  expect(readFileSync(stub.calls, 'utf8')).toBe('docker compose\nsaw IMP_X=1\n');
});

test('it stands in for a binary of the same name further along PATH', () => {
  using ctx = setupTest();

  const stub = createStubBin(ctx.dir, 'ls', 'echo stubbed');

  const result = Bun.spawnSync(['bash', '-c', 'ls /'], {
    env: { PATH: `${stub.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('stubbed\n');
});
