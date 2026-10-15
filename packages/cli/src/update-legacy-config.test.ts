import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canUpdateReadOnly } from '@impz/test-utils/can-update-read-only';
import { updateReadOnly } from '@impz/test-utils/update-read-only';
import { updateLegacyConfig } from './update-legacy-config';

// `stack` makes a read-only tree writable again before the directory goes
function setupTest() {
  const stack = new DisposableStack();

  onTestFinished(() => {
    stack.dispose();
  });

  const dir = mkdtempSync(join(tmpdir(), 'impz-legacy-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, stack };
}

test('it moves the saved hosts and the token file from the old directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), '{"current":null,"hosts":{}}\n');
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');

  const warn = mock<(line: string) => void>();

  updateLegacyConfig(join(ctx.dir, 'impz'), warn);

  expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );

  expect(readFileSync(join(ctx.dir, 'impz', 'token'), 'utf8')).toBe('file-token\n');
  expect(existsSync(join(ctx.dir, 'imp'))).toBeFalse();
  expect(statSync(join(ctx.dir, 'impz')).mode & 0o777).toBe(0o700);

  expect(warn.mock.calls).toStrictEqual([
    [
      `impz: moved ${join(ctx.dir, 'imp', 'config.json')} to ${join(ctx.dir, 'impz', 'config.json')}`,
    ],
    [`impz: moved ${join(ctx.dir, 'imp', 'token')} to ${join(ctx.dir, 'impz', 'token')}`],
  ]);
});

test('it never moves over a file impz has already', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), 'old\n');
  mkdirSync(join(ctx.dir, 'impz'));
  writeFileSync(join(ctx.dir, 'impz', 'config.json'), 'new\n');

  const warn = mock<(line: string) => void>();

  updateLegacyConfig(join(ctx.dir, 'impz'), warn);

  expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe('new\n');
  expect(readFileSync(join(ctx.dir, 'imp', 'config.json'), 'utf8')).toBe('old\n');
  expect(warn).not.toHaveBeenCalled();
});

test.skipIf(!canUpdateReadOnly())(
  'it finishes a move that failed after it made the directory, once the old one is writable again',
  () => {
    const ctx = setupTest();

    mkdirSync(join(ctx.dir, 'imp'));
    writeFileSync(join(ctx.dir, 'imp', 'config.json'), '{"current":null,"hosts":{}}\n');
    writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');

    const restore = updateReadOnly(ctx.stack, join(ctx.dir, 'imp'));

    const failure: unknown = (() => {
      try {
        updateLegacyConfig(join(ctx.dir, 'impz'), mock<(line: string) => void>());
      } catch (error) {
        return error;
      }

      return null;
    })();

    const leftBehind = readdirSync(join(ctx.dir, 'impz'));

    restore();

    const warn = mock<(line: string) => void>();

    updateLegacyConfig(join(ctx.dir, 'impz'), warn);

    expect(failure).toMatchObject({ code: expect.toBeOneOf(['EACCES', 'EPERM']) });
    expect(leftBehind).toStrictEqual([]);

    expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe(
      '{"current":null,"hosts":{}}\n',
    );

    expect(readFileSync(join(ctx.dir, 'impz', 'token'), 'utf8')).toBe('file-token\n');
    expect(existsSync(join(ctx.dir, 'imp'))).toBeFalse();

    expect(warn.mock.calls).toStrictEqual([
      [
        `impz: moved ${join(ctx.dir, 'imp', 'config.json')} to ${join(ctx.dir, 'impz', 'config.json')}`,
      ],
      [`impz: moved ${join(ctx.dir, 'imp', 'token')} to ${join(ctx.dir, 'impz', 'token')}`],
    ]);
  },
);

test('it moves the file a part-way move left behind, beside the one it moved', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');
  mkdirSync(join(ctx.dir, 'impz'));
  writeFileSync(join(ctx.dir, 'impz', 'config.json'), '{"current":null,"hosts":{}}\n');
  updateLegacyConfig(join(ctx.dir, 'impz'), mock<(line: string) => void>());

  expect(readdirSync(join(ctx.dir, 'impz')).toSorted()).toStrictEqual(['config.json', 'token']);
  expect(readFileSync(join(ctx.dir, 'impz', 'token'), 'utf8')).toBe('file-token\n');
});

test('it makes no directory when the old one holds neither file', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'notes.txt'), 'another tool\n');
  updateLegacyConfig(join(ctx.dir, 'impz'), mock<(line: string) => void>());

  expect(readdirSync(ctx.dir)).toStrictEqual(['imp']);
});

test('it leaves the old directory with whatever else it holds', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');
  writeFileSync(join(ctx.dir, 'imp', 'notes.txt'), 'kept\n');
  updateLegacyConfig(join(ctx.dir, 'impz'), mock<(line: string) => void>());

  expect(readdirSync(join(ctx.dir, 'imp'))).toStrictEqual(['notes.txt']);
  expect(readFileSync(join(ctx.dir, 'impz', 'token'), 'utf8')).toBe('file-token\n');
});

test('it moves a relative symlink that still resolves after the move', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'dotfiles'));
  writeFileSync(join(ctx.dir, 'dotfiles', 'config.json'), '{"current":null,"hosts":{}}\n');
  mkdirSync(join(ctx.dir, 'imp'));
  symlinkSync('../dotfiles/config.json', join(ctx.dir, 'imp', 'config.json'));
  updateLegacyConfig(join(ctx.dir, 'impz'), mock<(line: string) => void>());

  expect(readlinkSync(join(ctx.dir, 'impz', 'config.json'))).toBe('../dotfiles/config.json');

  expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it points a moved symlink at a file that stays in the old directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'hosts.json'), '{"current":null,"hosts":{}}\n');
  symlinkSync('hosts.json', join(ctx.dir, 'imp', 'config.json'));
  updateLegacyConfig(join(ctx.dir, 'impz'), mock<(line: string) => void>());

  expect(readlinkSync(join(ctx.dir, 'impz', 'config.json'))).toBe('../imp/hosts.json');

  expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it points a moved symlink at the other moved file', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), '{"current":null,"hosts":{}}\n');
  symlinkSync('./config.json', join(ctx.dir, 'imp', 'token'));
  updateLegacyConfig(join(ctx.dir, 'impz'), mock<(line: string) => void>());

  expect(readlinkSync(join(ctx.dir, 'impz', 'token'))).toBe('config.json');

  expect(readFileSync(join(ctx.dir, 'impz', 'token'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it keeps an absolute symlink as it was', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'root-token'), 'root\n');
  mkdirSync(join(ctx.dir, 'imp'));
  symlinkSync(join(ctx.dir, 'root-token'), join(ctx.dir, 'imp', 'token'));
  updateLegacyConfig(join(ctx.dir, 'impz'), mock<(line: string) => void>());

  expect(readlinkSync(join(ctx.dir, 'impz', 'token'))).toBe(join(ctx.dir, 'root-token'));
});

test('it points a moved relative symlink at its file when the old directory is itself a symlink', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'dotfiles', 'imp'), { recursive: true });
  writeFileSync(join(ctx.dir, 'dotfiles', 'hosts.json'), '{"current":null,"hosts":{}}\n');
  symlinkSync('../hosts.json', join(ctx.dir, 'dotfiles', 'imp', 'config.json'));
  mkdirSync(join(ctx.dir, 'config'));
  symlinkSync('../dotfiles/imp', join(ctx.dir, 'config', 'imp'));
  updateLegacyConfig(join(ctx.dir, 'config', 'impz'), mock<(line: string) => void>());

  expect(readFileSync(join(ctx.dir, 'config', 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});
