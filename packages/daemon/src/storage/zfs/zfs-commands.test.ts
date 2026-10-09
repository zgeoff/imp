import { expect, mock, test } from 'bun:test';
import {
  buildReceiveArgv,
  buildSendArgv,
  createZfsCommands,
  parseSendSize,
  parseZfsList,
  parseZfsMounts,
  parseZfsRelease,
  parseZfsSpace,
  parseZfsVersion,
} from './zfs-commands';
import type { CommandRunner } from './zfs-commands';

// The rows below are what OpenZFS 2.2 prints: tabs between columns, `-`
// where a property does not apply.

test('#parseZfsList reads zfs list rows as filesystems and snapshots', () => {
  const stdout = [
    'tank/imp\tfilesystem\t-\t-',
    'tank/imp/images/9f2c\tfilesystem\t-\t-',
    'tank/imp/images/9f2c@base\tsnapshot\t-\toff',
    'tank/imp/disks/0199a\tfilesystem\ttank/imp/images/9f2c@base\t-',
    'tank/imp/disks/0199a@cp-abc234\tsnapshot\t-\ton',
    '',
  ].join('\n');

  expect(parseZfsList(stdout)).toStrictEqual([
    { name: 'tank/imp', type: 'filesystem', origin: null, deferDestroy: false },
    { name: 'tank/imp/images/9f2c', type: 'filesystem', origin: null, deferDestroy: false },
    { name: 'tank/imp/images/9f2c@base', type: 'snapshot', origin: null, deferDestroy: false },
    {
      name: 'tank/imp/disks/0199a',
      type: 'filesystem',
      origin: 'tank/imp/images/9f2c@base',
      deferDestroy: false,
    },
    { name: 'tank/imp/disks/0199a@cp-abc234', type: 'snapshot', origin: null, deferDestroy: true },
  ]);
});

test('#parseZfsList refuses a row of a type impd does not make', () => {
  expect(() => parseZfsList('tank/vol\tvolume\t-\t-\n')).toThrowWithMessage(
    Error,
    String.raw`zfs list: unexpected row "tank/vol\tvolume\t-\t-"`,
  );
});

test('#parseZfsVersion reads the userland version, not the kernel module', () => {
  expect(parseZfsVersion('zfs-2.2.2-0ubuntu9\nzfs-kmod-2.2.2-0ubuntu9.1\n')).toBe('2.2.2-0ubuntu9');
});

test('#parseZfsVersion refuses output with no version', () => {
  expect(() => parseZfsVersion('zfs: command not found\n')).toThrowWithMessage(
    Error,
    'zfs version: unexpected output "zfs: command not found"',
  );
});

test.each([
  ['2.2.2-0ubuntu9', { major: '2', minor: '2' }],
  ['2.3.1-1\n', { major: '2', minor: '3' }],
  ['unknown', { major: 'unknown', minor: '' }],
])('#parseZfsRelease splits %p into its major and minor', (version, expected) => {
  expect(parseZfsRelease(version)).toStrictEqual(expected);
});

test('#parseZfsMounts finds the zfs mounts in the mount table, spaces decoded', () => {
  const mounts = [
    'overlay / overlay rw,relatime 0 0',
    'tank/imp /var/lib/imp zfs rw,noatime,xattr,noacl,casesensitive 0 0',
    'tank/imp/disks/a /var/lib/imp/imps/a/disk zfs rw,noatime,xattr,noacl 0 0',
    String.raw`tank/imp/odd /var/lib/imp/with\040space zfs rw 0 0`,
  ].join('\n');

  expect(parseZfsMounts(mounts)).toStrictEqual(
    new Map([
      ['/var/lib/imp', 'tank/imp'],
      ['/var/lib/imp/imps/a/disk', 'tank/imp/disks/a'],
      ['/var/lib/imp/with space', 'tank/imp/odd'],
    ]),
  );
});

test('#parseZfsSpace reads the space columns, with the clones of a snapshot', () => {
  const stdout = [
    'tank/imp/disks/a\t2048\t4096\t1024\t1790985600\t-',
    'tank/imp/disks/a@cp-1\t512\t3072\t-\t1790989200\ttank/imp/disks/b,tank/imp/staging/bk-1',
    '',
  ].join('\n');

  expect(parseZfsSpace(stdout)).toStrictEqual([
    {
      name: 'tank/imp/disks/a',
      used: 2048,
      referenced: 4096,
      usedByDataset: 1024,
      createdAt: new Date('2026-10-03T00:00:00Z'),
      clones: [],
    },
    {
      name: 'tank/imp/disks/a@cp-1',
      used: 512,
      referenced: 3072,
      usedByDataset: 0,
      createdAt: new Date('2026-10-03T01:00:00Z'),
      clones: ['tank/imp/disks/b', 'tank/imp/staging/bk-1'],
    },
  ]);
});

test('#parseZfsSpace reads a creation it cannot parse as no time', () => {
  expect(parseZfsSpace('tank/imp/disks/a\t2048\t4096\t1024\t-\t-\n')).toStrictEqual([
    {
      name: 'tank/imp/disks/a',
      used: 2048,
      referenced: 4096,
      usedByDataset: 1024,
      createdAt: null,
      clones: [],
    },
  ]);
});

test('#parseSendSize reads the size line of a full send estimate', () => {
  expect(parseSendSize('full\ttank/imp/disks/a@cp-one\t1048576\nsize\t1048576\n')).toBe(1_048_576);
});

test('#parseSendSize reads the size line of an incremental send estimate', () => {
  expect(parseSendSize('incremental\tcp-one\ttank/imp/disks/a@cp-two\t4096\nsize\t4096\n')).toBe(
    4096,
  );
});

test('#parseSendSize refuses an estimate with no size line', () => {
  expect(() => parseSendSize('nothing\n')).toThrowWithMessage(
    Error,
    'zfs send -nP: no size in "nothing"',
  );
});

test.each([
  ['a full send', null, ['zfs', 'send', 'tank/imp/disks/a@mv-1']],
  [
    'an incremental send',
    'tank/imp/disks/a@cp-1',
    ['zfs', 'send', '-i', 'tank/imp/disks/a@cp-1', 'tank/imp/disks/a@mv-1'],
  ],
])('#buildSendArgv builds %s', (_label, base, expected) => {
  expect(buildSendArgv('tank/imp/disks/a@mv-1', base)).toStrictEqual(expected);
});

test.each([
  ['an unmounted receive', null, ['zfs', 'recv', '-u', 'tank/imp/staging/mv-a']],
  [
    'a receive of a clone that names its origin',
    'tank/imp/images/abc@base',
    ['zfs', 'recv', '-u', '-o', 'origin=tank/imp/images/abc@base', 'tank/imp/staging/mv-a'],
  ],
])('#buildReceiveArgv builds %s', (_label, origin, expected) => {
  expect(buildReceiveArgv('tank/imp/staging/mv-a', origin)).toStrictEqual(expected);
});

test('#create makes a dataset with the properties given', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).create('tank/imp/disks', { recordsize: '16K' });

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'create',
    '-o',
    'recordsize=16K',
    'tank/imp/disks',
  ]);
});

test('#snapshot takes a snapshot', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).snapshot('tank/imp/disks/a@cp-abc234');

  expect(run).toHaveBeenCalledExactlyOnceWith(['zfs', 'snapshot', 'tank/imp/disks/a@cp-abc234']);
});

test('#clone clones a snapshot', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).clone('tank/imp/disks/a@cp-abc234', 'tank/imp/disks/b');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'clone',
    'tank/imp/disks/a@cp-abc234',
    'tank/imp/disks/b',
  ]);
});

test('#clone clones a snapshot with the properties given', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).clone('tank/imp/disks/a@cp-abc234', 'tank/imp/disks/c', {
    recordsize: '16K',
  });

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'clone',
    '-o',
    'recordsize=16K',
    'tank/imp/disks/a@cp-abc234',
    'tank/imp/disks/c',
  ]);
});

test('#rename renames a dataset', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).rename('tank/imp/disks/a', 'tank/imp/retired/r');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'rename',
    'tank/imp/disks/a',
    'tank/imp/retired/r',
  ]);
});

test('#promote promotes a clone', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).promote('tank/imp/disks/b');

  expect(run).toHaveBeenCalledExactlyOnceWith(['zfs', 'promote', 'tank/imp/disks/b']);
});

test('#destroy destroys a dataset', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).destroy('tank/imp/retired/r');

  expect(run).toHaveBeenCalledExactlyOnceWith(['zfs', 'destroy', 'tank/imp/retired/r']);
});

test('#destroyDeferred marks a snapshot for deferred destroy', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).destroyDeferred('tank/imp/disks/b@cp-abc234');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'destroy',
    '-d',
    'tank/imp/disks/b@cp-abc234',
  ]);
});

test('#destroyRecursive destroys a dataset with its snapshots', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).destroyRecursive('tank/imp/staging/restore-a');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'destroy',
    '-r',
    'tank/imp/staging/restore-a',
  ]);
});

test('#mount mounts a dataset with a legacy mount', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).mount('tank/imp/disks/b', '/var/lib/imp/imps/b/disk');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'mount',
    '-t',
    'zfs',
    'tank/imp/disks/b',
    '/var/lib/imp/imps/b/disk',
  ]);
});

test('#mount mounts a dataset read-only when asked', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).mount('tank/imp/staging/bk-b', '/var/lib/imp/backup/tree/b', {
    isReadOnly: true,
  });

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'mount',
    '-t',
    'zfs',
    '-o',
    'ro',
    'tank/imp/staging/bk-b',
    '/var/lib/imp/backup/tree/b',
  ]);
});

test('#unmount unmounts a dir', async () => {
  const run = mock<CommandRunner>(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

  await createZfsCommands(run).unmount('/var/lib/imp/imps/b/disk');

  expect(run).toHaveBeenCalledExactlyOnceWith(['umount', '/var/lib/imp/imps/b/disk']);
});

test('#list lists the tree oldest first', async () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({
      exitCode: 0,
      stdout: 'tank/imp\tfilesystem\t-\t-\ntank/imp/disks\tfilesystem\t-\t-\n',
      stderr: '',
    }),
  );

  const entries = await createZfsCommands(run).list('tank/imp');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'list',
    '-Hp',
    '-r',
    '-t',
    'filesystem,snapshot',
    '-s',
    'createtxg',
    '-o',
    'name,type,origin,defer_destroy',
    'tank/imp',
  ]);

  expect(entries.map((entry) => entry.name)).toStrictEqual(['tank/imp', 'tank/imp/disks']);
});

test('#listSpace lists the space of every dataset and snapshot under the root', async () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({
      exitCode: 0,
      stdout: 'tank/imp\t2048\t4096\t1024\t1790985600\t-\n',
      stderr: '',
    }),
  );

  const space = await createZfsCommands(run).listSpace('tank/imp');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'list',
    '-Hp',
    '-r',
    '-t',
    'filesystem,snapshot',
    '-o',
    'name,used,referenced,usedbydataset,creation,clones',
    'tank/imp',
  ]);

  expect(space.map((entry) => entry.used)).toStrictEqual([2048]);
});

test('#estimateSend estimates an incremental send', async () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({
      exitCode: 0,
      stdout: 'incremental\tcp-1\ttank/imp/disks/a@mv-1\t4096\nsize\t4096\n',
      stderr: '',
    }),
  );

  const bytes = await createZfsCommands(run).estimateSend(
    'tank/imp/disks/a@mv-1',
    'tank/imp/disks/a@cp-1',
  );

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'send',
    '-nP',
    '-i',
    'tank/imp/disks/a@cp-1',
    'tank/imp/disks/a@mv-1',
  ]);

  expect(bytes).toBe(4096);
});

test('#readWritten reads the bytes written before a snapshot', async () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({ exitCode: 0, stdout: '65536\n', stderr: '' }),
  );

  const written = await createZfsCommands(run).readWritten('tank/imp/disks/a@cp-x');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'get',
    '-Hp',
    '-o',
    'value',
    'written',
    'tank/imp/disks/a@cp-x',
  ]);

  expect(written).toBe(65_536);
});

test('#readUsage reads the used and available bytes of a dataset', async () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({ exitCode: 0, stdout: '1073741824\t9663676416\n', stderr: '' }),
  );

  const usage = await createZfsCommands(run).readUsage('tank/imp');

  expect(run).toHaveBeenCalledExactlyOnceWith([
    'zfs',
    'list',
    '-Hp',
    '-o',
    'used,available',
    'tank/imp',
  ]);

  expect(usage).toStrictEqual({ used: 1_073_741_824, available: 9_663_676_416 });
});

test('#readVersion reads the userland version from zfs version', async () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({
      exitCode: 0,
      stdout: 'zfs-2.2.2-0ubuntu9\nzfs-kmod-2.2.2-0ubuntu9.1\n',
      stderr: '',
    }),
  );

  const version = await createZfsCommands(run).readVersion();

  expect(run).toHaveBeenCalledExactlyOnceWith(['zfs', 'version']);
  expect(version).toBe('2.2.2-0ubuntu9');
});

test('#readWritten refuses a size that is not an exact byte count', () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({ exitCode: 0, stdout: '12K\n', stderr: '' }),
  );

  expect(createZfsCommands(run).readWritten('tank/imp/disks/a@cp-x')).rejects.toThrowWithMessage(
    Error,
    'zfs: expected a byte count, got "12K"',
  );
});

test('#destroy fails with the stderr of zfs when zfs exits non-zero', () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: "cannot destroy 'tank/imp/disks/a@cp-x': snapshot has dependent clones\n",
    }),
  );

  expect(createZfsCommands(run).destroy('tank/imp/disks/a@cp-x')).rejects.toThrowWithMessage(
    Error,
    "zfs destroy tank/imp/disks/a@cp-x exited 1: cannot destroy 'tank/imp/disks/a@cp-x': snapshot has dependent clones",
  );
});

test('#destroy fails with the stdout of zfs when its stderr is empty', () => {
  const run = mock<CommandRunner>(() =>
    Promise.resolve({ exitCode: 2, stdout: 'usage: zfs destroy ...\n', stderr: '' }),
  );

  expect(createZfsCommands(run).destroy('tank/imp/disks/a')).rejects.toThrowWithMessage(
    Error,
    'zfs destroy tank/imp/disks/a exited 2: usage: zfs destroy ...',
  );
});
