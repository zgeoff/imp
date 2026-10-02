import { expect, test } from 'bun:test';
import {
  createZfsCommands,
  parseZfsList,
  parseZfsMounts,
  parseZfsRelease,
  parseZfsVersion,
} from './zfs-commands';

// `zfs list -Hp -r -t filesystem,snapshot -s createtxg -o name,type,origin,defer_destroy`
// on OpenZFS 2.2: tabs between columns, `-` where a property does not apply
const LIST_OUTPUT = [
  'tank/imp\tfilesystem\t-\t-',
  'tank/imp/images\tfilesystem\t-\t-',
  'tank/imp/images/9f2c\tfilesystem\t-\t-',
  'tank/imp/images/9f2c@base\tsnapshot\t-\toff',
  'tank/imp/disks/0199a\tfilesystem\ttank/imp/images/9f2c@base\t-',
  'tank/imp/disks/0199a@cp-abc234\tsnapshot\t-\ton',
  '',
].join('\n');

function setupRecorder(stdout = '') {
  const argvs: string[] = [];

  const zfs = createZfsCommands((argv) => {
    argvs.push(argv.join(' '));

    return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
  });

  return { zfs, argvs };
}

test('it parses zfs list rows into filesystems and snapshots', () => {
  expect(parseZfsList(LIST_OUTPUT)).toEqual([
    { name: 'tank/imp', type: 'filesystem', origin: null, deferDestroy: false },
    { name: 'tank/imp/images', type: 'filesystem', origin: null, deferDestroy: false },
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

test('it refuses a zfs list row of a type impd does not make', () => {
  expect(() => parseZfsList('tank/vol\tvolume\t-\t-\n')).toThrow('unexpected row');
});

test('it reads the userland version and splits a release into major and minor', () => {
  const stdout = 'zfs-2.2.2-0ubuntu9\nzfs-kmod-2.2.2-0ubuntu9.1\n';

  expect(parseZfsVersion(stdout)).toBe('2.2.2-0ubuntu9');
  expect(parseZfsRelease('2.2.2-0ubuntu9')).toEqual({ major: '2', minor: '2' });
  expect(parseZfsRelease('2.3.1-1\n')).toEqual({ major: '2', minor: '3' });
  expect(() => parseZfsVersion('zfs: command not found')).toThrow('unexpected output');
});

test('it finds the zfs mounts in /proc/self/mounts', () => {
  const mounts = [
    'overlay / overlay rw,relatime 0 0',
    'tank/imp /var/lib/imp zfs rw,noatime,xattr,noacl,casesensitive 0 0',
    'tank/imp/disks/a /var/lib/imp/imps/a/disk zfs rw,noatime,xattr,noacl 0 0',
    String.raw`tank/imp/odd /var/lib/imp/with\040space zfs rw 0 0`,
  ].join('\n');

  expect(parseZfsMounts(mounts)).toEqual(
    new Map([
      ['/var/lib/imp', 'tank/imp'],
      ['/var/lib/imp/imps/a/disk', 'tank/imp/disks/a'],
      ['/var/lib/imp/with space', 'tank/imp/odd'],
    ]),
  );
});

test('it runs each operation as one exact command', async () => {
  const recorder = setupRecorder();
  const zfs = recorder.zfs;

  await zfs.create('tank/imp/disks', { recordsize: '16K' });
  await zfs.snapshot('tank/imp/disks/a@cp-abc234');
  await zfs.clone('tank/imp/disks/a@cp-abc234', 'tank/imp/disks/b');
  await zfs.rename('tank/imp/disks/a', 'tank/imp/retired/r');
  await zfs.promote('tank/imp/disks/b');
  await zfs.destroy('tank/imp/retired/r');
  await zfs.destroyDeferred('tank/imp/disks/b@cp-abc234');
  await zfs.mount('tank/imp/disks/b', '/var/lib/imp/imps/b/disk');
  await zfs.unmount('/var/lib/imp/imps/b/disk');

  expect(recorder.argvs).toEqual([
    'zfs create -o recordsize=16K tank/imp/disks',
    'zfs snapshot tank/imp/disks/a@cp-abc234',
    'zfs clone tank/imp/disks/a@cp-abc234 tank/imp/disks/b',
    'zfs rename tank/imp/disks/a tank/imp/retired/r',
    'zfs promote tank/imp/disks/b',
    'zfs destroy tank/imp/retired/r',
    'zfs destroy -d tank/imp/disks/b@cp-abc234',
    'mount -t zfs tank/imp/disks/b /var/lib/imp/imps/b/disk',
    'umount /var/lib/imp/imps/b/disk',
  ]);
});

test('it reads sizes as exact byte counts', async () => {
  const written = setupRecorder('65536\n');

  const writtenBytes = await written.zfs.readWritten('tank/imp/disks/a@cp-x');

  expect(writtenBytes).toBe(65_536);
  expect(written.argvs).toEqual(['zfs get -Hp -o value written tank/imp/disks/a@cp-x']);

  const usage = setupRecorder('1073741824\t9663676416\n');

  const usageBytes = await usage.zfs.readUsage('tank/imp');

  expect(usageBytes).toEqual({
    used: 1_073_741_824,
    available: 9_663_676_416,
  });

  expect(usage.argvs).toEqual(['zfs list -Hp -o used,available tank/imp']);

  const garbled = setupRecorder('12K\n');

  const garbledError = await garbled.zfs.readWritten('tank/imp/disks/a@cp-x').catch(String);

  expect(garbledError).toContain('byte count');
});

test('it lists the tree oldest first and fails with the stderr of zfs', async () => {
  const listing = setupRecorder(LIST_OUTPUT);

  const entries = await listing.zfs.list('tank/imp');

  expect(entries).toHaveLength(6);

  expect(listing.argvs).toEqual([
    'zfs list -Hp -r -t filesystem,snapshot -s createtxg -o name,type,origin,defer_destroy tank/imp',
  ]);

  const failing = createZfsCommands(() =>
    Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: "cannot destroy 'tank/imp/disks/a@cp-x': snapshot has dependent clones\n",
    }),
  );

  const failure = await failing.destroy('tank/imp/disks/a@cp-x').catch(String);

  expect(failure).toContain(
    "zfs destroy tank/imp/disks/a@cp-x exited 1: cannot destroy 'tank/imp/disks/a@cp-x': snapshot has dependent clones",
  );
});
