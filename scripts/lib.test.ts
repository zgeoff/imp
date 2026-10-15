import { expect, onTestFinished, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from './test-utils/create-stub-bin';
import { runSourcedFunction } from './test-utils/run-sourced-function';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-lib-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('#dev_image_tag gives a checkout the same tag every time', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  const first = runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/a/imp'] });
  const second = runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/a/imp'] });

  expect(first.exitCode).toBe(0);
  expect(first.stdout).toMatch(/^imp-host:dev-imp-[0-9a-f]{8}\n$/u);
  expect(second).toStrictEqual(first);
});

test('#dev_image_tag gives another checkout of the same name another tag', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  const one = runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/a/imp'] });
  const other = runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/b/imp'] });

  expect(other.stdout).toStartWith('imp-host:dev-imp-');
  expect(other.stdout).not.toBe(one.stdout);
});

test.each([['/w/My Work Tree'], ['/w/.hidden'], ['/w/wörk'], [`/w/${'x'.repeat(200)}`]])(
  '#dev_image_tag keeps the tag of %p to the characters and length Docker allows',
  (root) => {
    const script = new URL('lib.sh', import.meta.url).pathname;

    // Docker's tag grammar, after the imp-host repository
    expect(runSourcedFunction({ script, fn: 'dev_image_tag', args: [root] }).stdout).toMatch(
      /^imp-host:\w[\w.-]{0,127}\n$/u,
    );
  },
);

test('#dev_image_tag turns the blanks of a checkout name into dashes', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/w/My Work Tree'] }).stdout,
  ).toMatch(/^imp-host:dev-My-Work-Tree-[0-9a-f]{8}\n$/u);
});

test('#dev_image_tag cuts a long checkout name to 40 characters', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'dev_image_tag', args: [`/w/${'x'.repeat(200)}`] }).stdout,
  ).toMatch(/^imp-host:dev-x{40}-[0-9a-f]{8}\n$/u);
});

test('#IMP_HOST_IMAGE defaults to the tag of the checkout lib.sh is in', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  const root = realpathSync(new URL('..', import.meta.url).pathname);
  const image = runSourcedFunction({ script, fn: 'eval', args: ['printf %s "$IMP_HOST_IMAGE"'] });
  const tag = runSourcedFunction({ script, fn: 'dev_image_tag', args: [root] });

  expect(image.stdout).toBe(tag.stdout.trim());
});

test('#IMP_HOST_IMAGE defaults to the same tag for a checkout reached through a symlink', () => {
  const ctx = setupTest();
  const link = join(ctx.dir, 'linked-checkout');

  symlinkSync(realpathSync(new URL('..', import.meta.url).pathname), link);

  const linked = runSourcedFunction({
    script: join(link, 'scripts', 'lib.sh'),
    fn: 'eval',
    args: ['printf %s "$IMP_HOST_IMAGE"'],
  });

  const direct = runSourcedFunction({
    script: new URL('lib.sh', import.meta.url).pathname,
    fn: 'eval',
    args: ['printf %s "$IMP_HOST_IMAGE"'],
  });

  expect(direct.stdout).toStartWith('imp-host:dev-');
  expect(linked).toStrictEqual(direct);
});

test('#IMP_HOST_IMAGE keeps the value the environment sets', () => {
  expect(
    runSourcedFunction({
      script: new URL('lib.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['printf %s "$IMP_HOST_IMAGE"'],
      env: { IMP_HOST_IMAGE: 'imp-host:dev' },
    }),
  ).toStrictEqual({ exitCode: 0, stdout: 'imp-host:dev', stderr: '' });
});

test('#load_tailscale_authkey keeps a key from the env out of a bash -x trace', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      'bash',
      '-x',
      '-c',
      'source "$1"; load_tailscale_authkey; echo "found $?"',
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: ctx.dir,
        TAILSCALE_AUTHKEY: 'fake-tskey-for-the-trace-check',
      },
    },
  );

  expect(result.stdout.toString()).toBe('found 0\n');
  expect(result.stderr.toString()).not.toContain('fake-tskey-for-the-trace-check');
});

test('#load_tailscale_authkey exports a key from op and keeps it out of a bash -x trace', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', "echo 'fake-tskey-for-the-trace-check'");

  // the comparison runs untraced: only the function's own trace is checked
  const result = Bun.spawnSync(
    [
      'bash',
      '-x',
      '-c',
      `source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey
      { set +x; } 2>/dev/null; [ "$TAILSCALE_AUTHKEY" = 'fake-tskey-for-the-trace-check' ] && echo match`,
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${op.bin}:${process.env['PATH'] ?? ''}`,
        HOME: ctx.dir,
        IMP_TAILSCALE_OP: '1',
      },
    },
  );

  expect(result.stdout.toString()).toBe('match\n');
  expect(result.stderr.toString()).not.toContain('fake-tskey-for-the-trace-check');
});

test('#load_tailscale_authkey asks op once in a run after an op miss', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', 'exit 1');

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey; load_tailscale_authkey; echo "$IMP_TAILSCALE_OP_MISSED"',
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${op.bin}:${process.env['PATH'] ?? ''}`,
        HOME: ctx.dir,
        IMP_TAILSCALE_OP: '1',
      },
    },
  );

  expect(result.stdout.toString()).toBe('1\n');

  expect(readFileSync(op.calls, 'utf8')).toBe(
    'op read op://imp-e2e/imp-e2e-tailscale-oauth/client-secret\n',
  );
});

test("#load_tailscale_authkey joins a dev instance with impz's tag:imp-e2e client from op, ephemeral and preauthorized, untraced", () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', "echo 'tskey-client-fake-for-the-trace-check'");

  // the comparison runs untraced: only the function's own trace is checked
  const result = Bun.spawnSync(
    [
      'bash',
      '-x',
      '-c',
      `source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey; echo "found $?"
      { set +x; } 2>/dev/null
      [ "$TAILSCALE_AUTHKEY" = 'tskey-client-fake-for-the-trace-check?ephemeral=true&preauthorized=true' ] && echo match
      echo "$IMP_TAILSCALE_TAGS"`,
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${op.bin}:${process.env['PATH'] ?? ''}`,
        HOME: ctx.dir,
        IMP_TAILSCALE_OP: '1',
      },
    },
  );

  expect(result.stdout.toString()).toBe('found 0\nmatch\ntag:imp-e2e\n');
  expect(result.stderr.toString()).not.toContain('tskey-client-fake-for-the-trace-check');

  expect(readFileSync(op.calls, 'utf8')).toBe(
    'op read op://imp-e2e/imp-e2e-tailscale-oauth/client-secret\n',
  );
});

test('#load_tailscale_authkey keeps the tags IMP_TAILSCALE_TAGS sets for a client secret from op', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', "echo 'tskey-client-fake-other'");

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey; echo "found $? [$IMP_TAILSCALE_TAGS]"',
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${op.bin}:${process.env['PATH'] ?? ''}`,
        HOME: ctx.dir,
        IMP_TAILSCALE_OP: '1',
        IMP_TAILSCALE_TAGS: 'tag:sandbox-dev',
      },
    },
  );

  expect(result.stdout.toString()).toBe('found 0 [tag:sandbox-dev]\n');
});

test('#load_tailscale_authkey never asks op without IMP_TAILSCALE_OP=1', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', "echo 'fake-tskey-for-the-trace-check'");

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'source "$1"; unset TAILSCALE_AUTHKEY; load_tailscale_authkey; echo "found $?"',
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
    ],
    { env: { PATH: `${op.bin}:${process.env['PATH'] ?? ''}`, HOME: ctx.dir } },
  );

  // the run reaches its end: sourcing and the lookup left the shell alive
  expect(result.exitCode).toBe(0);
  expect(readFileSync(op.calls, 'utf8')).toBe('');
});

test('#load_tailscale_e2e_authkey joins e2e nodes with the tag:imp-e2e client from op, ephemeral and preauthorized, untraced', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', "echo 'fake-tskey-client-for-the-trace-check'");

  // the comparison runs untraced: only the function's own trace is checked
  const result = Bun.spawnSync(
    [
      'bash',
      '-x',
      '-c',
      `source "$1"; load_tailscale_e2e_authkey; echo "found $?"
      { set +x; } 2>/dev/null
      [ "$TAILSCALE_AUTHKEY" = 'fake-tskey-client-for-the-trace-check?ephemeral=true&preauthorized=true' ] && echo match
      echo "$IMP_TAILSCALE_TAGS"`,
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
    ],
    { env: { PATH: `${op.bin}:${process.env['PATH'] ?? ''}`, HOME: ctx.dir } },
  );

  expect(result.stdout.toString()).toBe('found 0\nmatch\ntag:imp-e2e\n');
  expect(result.stderr.toString()).not.toContain('fake-tskey-client-for-the-trace-check');

  expect(readFileSync(op.calls, 'utf8')).toBe(
    'op read op://imp-e2e/imp-e2e-tailscale-oauth/client-secret\n',
  );
});

test("#load_tailscale_e2e_authkey never gives e2e nodes dev's tag:imp key from the env or .env", () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', 'exit 1');

  writeFileSync(join(ctx.dir, '.env'), 'TAILSCALE_AUTHKEY=fake-tag-imp-key\n');

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'source "$1"; IMP_ROOT=$2; load_tailscale_e2e_authkey; echo "found $? [$TAILSCALE_AUTHKEY] [$IMP_TAILSCALE_TAGS]"',
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
      ctx.dir,
    ],
    {
      env: {
        PATH: `${op.bin}:${process.env['PATH'] ?? ''}`,
        HOME: ctx.dir,
        TAILSCALE_AUTHKEY: 'fake-tag-imp-key',
      },
    },
  );

  expect(result.stdout.toString()).toBe('found 1 [fake-tag-imp-key] []\n');
});

test('#load_tailscale_e2e_authkey takes the e2e client secret from IMP_E2E_TAILSCALE_AUTHKEY without asking op', () => {
  const ctx = setupTest();
  const op = createStubBin(ctx.dir, 'op', "echo 'fake-from-op'");

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'source "$1"; load_tailscale_e2e_authkey; echo "found $? [$TAILSCALE_AUTHKEY] [$IMP_TAILSCALE_TAGS]"',
      'bash',
      new URL('lib.sh', import.meta.url).pathname,
    ],
    {
      env: {
        PATH: `${op.bin}:${process.env['PATH'] ?? ''}`,
        HOME: ctx.dir,
        IMP_E2E_TAILSCALE_AUTHKEY: 'fake-client-secret?ephemeral=false',
      },
    },
  );

  expect(result.stdout.toString()).toBe(
    'found 0 [fake-client-secret?ephemeral=true&preauthorized=true] [tag:imp-e2e]\n',
  );

  expect(readFileSync(op.calls, 'utf8')).toBe('');
});
