import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { STUB_EPOCH_S, StubZfsCrashError, buildStubZfs } from './build-stub-zfs';

test('it starts with the root dataset mounted on the root dir', () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  expect(fake.readMounts()).toBe('tank/imp /var/lib/imp zfs rw,noatime,xattr,noacl 0 0\n');
  expect(fake.listDatasets()).toStrictEqual(['tank/imp']);
});

test('it creates a dataset under an existing parent', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'create', 'tank/imp/disks']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.listDatasets()).toStrictEqual(['tank/imp', 'tank/imp/disks']);
});

test('it refuses to create a dataset whose parent does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'create', 'tank/imp/disks/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot create 'tank/imp/disks/a': parent does not exist",
  });

  expect(fake.listDatasets()).toStrictEqual(['tank/imp']);
});

test('it refuses to create a dataset that already exists', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/disks']);

  const result = await fake.run(['zfs', 'create', 'tank/imp/disks']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot create 'tank/imp/disks': dataset already exists",
  });
});

test('it takes a snapshot of a dataset', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);

  const result = await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.listSnapshots()).toStrictEqual(['tank/imp/a@one']);
});

test('it refuses a snapshot of a dataset that does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot open 'tank/imp/a': dataset does not exist",
  });
});

test('it refuses a snapshot name that is taken', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const result = await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot create snapshot 'tank/imp/a@one': dataset already exists",
  });
});

test('it clones a snapshot with the properties given by -o', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const result = await fake.run([
    'zfs',
    'clone',
    '-o',
    'mountpoint=legacy',
    '-o',
    'imp:id=b',
    'tank/imp/a@one',
    'tank/imp/b',
  ]);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.readOrigin('tank/imp/b')).toBe('tank/imp/a@one');
  expect(fake.readProperty('tank/imp/b', 'mountpoint')).toBe('legacy');
  expect(fake.readProperty('tank/imp/b', 'imp:id')).toBe('b');
});

test('it refuses to clone a snapshot that does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);

  const result = await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot open 'tank/imp/a@one': dataset does not exist",
  });
});

test('it refuses a clone onto a dataset that exists', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'create', 'tank/imp/b']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const result = await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot create 'tank/imp/b': dataset already exists",
  });
});

test('it refuses a clone whose parent does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const result = await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/disks/b']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot create 'tank/imp/disks/b': parent does not exist",
  });
});

test('it moves the origin snapshot and every older one to the promoted clone', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@two']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@three']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@two', 'tank/imp/b']);
  await fake.run(['zfs', 'promote', 'tank/imp/b']);

  expect(fake.listSnapshots()).toStrictEqual([
    'tank/imp/a@three',
    'tank/imp/b@one',
    'tank/imp/b@two',
  ]);
});

test('it makes the old parent a clone of the promoted origin', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'promote', 'tank/imp/b']);

  expect(fake.readOrigin('tank/imp/a')).toBe('tank/imp/b@one');
  expect(fake.readOrigin('tank/imp/b')).toBeNull();
});

test('it gives the promoted clone the origin its old parent had', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/image']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/image@base']);
  await fake.run(['zfs', 'clone', 'tank/imp/image@base', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@cp']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@cp', 'tank/imp/b']);
  await fake.run(['zfs', 'promote', 'tank/imp/b']);

  expect(fake.readOrigin('tank/imp/b')).toBe('tank/imp/image@base');
  expect(fake.readOrigin('tank/imp/a')).toBe('tank/imp/b@cp');
});

test('it points other clones of a moved snapshot at its new name', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/c']);
  await fake.run(['zfs', 'promote', 'tank/imp/b']);

  expect(fake.readOrigin('tank/imp/c')).toBe('tank/imp/b@one');
});

test('it refuses to promote a dataset that is not a clone', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);

  const result = await fake.run(['zfs', 'promote', 'tank/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot promote 'tank/imp/a': not a cloned filesystem",
  });
});

test('it refuses a promote whose moving snapshot name the clone already has', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/b@one']);

  const result = await fake.run(['zfs', 'promote', 'tank/imp/b']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot promote 'tank/imp/b': snapshot name conflict",
  });

  expect(fake.readOrigin('tank/imp/b')).toBe('tank/imp/a@one');
  expect(fake.listSnapshots()).toStrictEqual(['tank/imp/a@one', 'tank/imp/b@one']);
});

test('it destroys an unmounted dataset with no snapshots or children', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);

  const result = await fake.run(['zfs', 'destroy', 'tank/imp/a']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.listDatasets()).toStrictEqual(['tank/imp']);
});

test('it refuses to destroy a mounted dataset as busy', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['mount', '-t', 'zfs', 'tank/imp/a', '/var/lib/imp/imps/a/disk']);

  const result = await fake.run(['zfs', 'destroy', 'tank/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot destroy 'tank/imp/a': dataset is busy",
  });
});

test('it refuses to destroy a dataset that has a snapshot', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const result = await fake.run(['zfs', 'destroy', 'tank/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot destroy 'tank/imp/a': filesystem has children",
  });
});

test('it refuses to destroy a dataset that has a child dataset', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/disks']);
  await fake.run(['zfs', 'create', 'tank/imp/disks/a']);

  const result = await fake.run(['zfs', 'destroy', 'tank/imp/disks']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot destroy 'tank/imp/disks': filesystem has children",
  });
});

test('it refuses to destroy a dataset that does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'destroy', 'tank/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot open 'tank/imp/a': dataset does not exist",
  });
});

test('it destroys a snapshot with no clones', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const result = await fake.run(['zfs', 'destroy', 'tank/imp/a@one']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.listSnapshots()).toStrictEqual([]);
});

test('it refuses to destroy a snapshot that does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);

  const result = await fake.run(['zfs', 'destroy', 'tank/imp/a@one']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'could not find any snapshots to destroy; check snapshot names.',
  });
});

test('it refuses to destroy a snapshot that has dependent clones', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);

  const result = await fake.run(['zfs', 'destroy', 'tank/imp/a@one']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot destroy 'tank/imp/a@one': snapshot has dependent clones",
  });
});

test('it marks a snapshot with clones for deferred destroy under -d', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);

  const result = await fake.run(['zfs', 'destroy', '-d', 'tank/imp/a@one']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.listSnapshots()).toStrictEqual(['tank/imp/a@one']);
  expect(fake.isDeferred('tank/imp/a@one')).toBeTrue();
});

test('it destroys a snapshot without clones at once under -d', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'destroy', '-d', 'tank/imp/a@one']);

  expect(fake.listSnapshots()).toStrictEqual([]);
});

test('it removes a deferred snapshot along with its last clone', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/c']);
  await fake.run(['zfs', 'destroy', '-d', 'tank/imp/a@one']);
  await fake.run(['zfs', 'destroy', 'tank/imp/b']);
  await fake.run(['zfs', 'destroy', 'tank/imp/c']);

  expect(fake.listSnapshots()).toStrictEqual([]);
});

test('it keeps a deferred snapshot while a clone of it remains', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/c']);
  await fake.run(['zfs', 'destroy', '-d', 'tank/imp/a@one']);
  await fake.run(['zfs', 'destroy', 'tank/imp/b']);

  expect(fake.listSnapshots()).toStrictEqual(['tank/imp/a@one']);
});

test('it keeps an unmarked snapshot when its last clone goes', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'destroy', 'tank/imp/b']);

  expect(fake.listSnapshots()).toStrictEqual(['tank/imp/a@one']);
});

test('it destroys a dataset and every snapshot on it under -r', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@two']);

  const result = await fake.run(['zfs', 'destroy', '-r', 'tank/imp/a']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.listDatasets()).toStrictEqual(['tank/imp']);
  expect(fake.listSnapshots()).toStrictEqual([]);
});

test('it refuses a recursive destroy of a dataset whose snapshot has clones', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);

  const result = await fake.run(['zfs', 'destroy', '-r', 'tank/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot destroy 'tank/imp/a@one': snapshot has dependent clones",
  });

  expect(fake.listDatasets()).toStrictEqual(['tank/imp', 'tank/imp/a', 'tank/imp/b']);
});

test('it renames a dataset along with its snapshots', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'create', 'tank/imp/retired']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const result = await fake.run(['zfs', 'rename', 'tank/imp/a', 'tank/imp/retired/a']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.listDatasets()).toStrictEqual(['tank/imp', 'tank/imp/retired', 'tank/imp/retired/a']);
  expect(fake.listSnapshots()).toStrictEqual(['tank/imp/retired/a@one']);
});

test('it points the clones of a renamed dataset at their origin by its new name', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'rename', 'tank/imp/a', 'tank/imp/c']);

  expect(fake.readOrigin('tank/imp/b')).toBe('tank/imp/c@one');
});

test('it refuses to rename a dataset that does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'rename', 'tank/imp/a', 'tank/imp/b']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot open 'tank/imp/a': dataset does not exist",
  });
});

test('it refuses a rename onto a dataset that exists', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'create', 'tank/imp/b']);

  const result = await fake.run(['zfs', 'rename', 'tank/imp/a', 'tank/imp/b']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot rename to 'tank/imp/b': dataset already exists or parent does not exist",
  });
});

test('it refuses a rename whose new parent does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);

  const result = await fake.run(['zfs', 'rename', 'tank/imp/a', 'tank/imp/retired/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      "cannot rename to 'tank/imp/retired/a': dataset already exists or parent does not exist",
  });
});

test('it refuses to rename a mounted dataset', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['mount', '-t', 'zfs', 'tank/imp/a', '/var/lib/imp/imps/a/disk']);

  const result = await fake.run(['zfs', 'rename', 'tank/imp/a', 'tank/imp/b']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'fake zfs: impd unmounts before a rename (tank/imp/a)',
  });
});

test('it refuses to rename a dataset that has children', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'create', 'tank/imp/a/b']);

  const result = await fake.run(['zfs', 'rename', 'tank/imp/a', 'tank/imp/c']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'fake zfs: impd never renames a dataset with children (tank/imp/a)',
  });
});

test('it mounts a dataset read-write on a legacy mount', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);

  const result = await fake.run(['mount', '-t', 'zfs', 'tank/imp/a', '/var/lib/imp/imps/a/disk']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(fake.readMounts()).toBe(
    [
      'tank/imp /var/lib/imp zfs rw,noatime,xattr,noacl 0 0\n',
      'tank/imp/a /var/lib/imp/imps/a/disk zfs rw,noatime,xattr,noacl 0 0\n',
    ].join(''),
  );
});

test('it lists a mount made with -o ro as read-only', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['mount', '-t', 'zfs', '-o', 'ro', 'tank/imp/a', '/var/lib/imp/backup']);

  expect(fake.readMounts()).toInclude(
    'tank/imp/a /var/lib/imp/backup zfs ro,noatime,xattr,noacl 0 0\n',
  );

  expect(fake.isReadOnlyAt('/var/lib/imp/backup')).toBeTrue();
});

test('it escapes a space in a mount dir as an octal 040', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['mount', '-t', 'zfs', 'tank/imp/a', '/var/lib/imp/with space']);

  expect(fake.readMounts()).toInclude(
    String.raw`tank/imp/a /var/lib/imp/with\040space zfs rw,noatime,xattr,noacl 0 0`,
  );
});

test('it refuses to mount a dataset that does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['mount', '-t', 'zfs', 'tank/imp/a', '/var/lib/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'mount: /var/lib/imp/a: tank/imp/a does not exist',
  });
});

test('it refuses to mount on a dir that already has a mount', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'create', 'tank/imp/b']);
  await fake.run(['mount', '-t', 'zfs', 'tank/imp/a', '/var/lib/imp/a']);

  const result = await fake.run(['mount', '-t', 'zfs', 'tank/imp/b', '/var/lib/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'mount: /var/lib/imp/a: already mounted',
  });

  expect(fake.readMountedAt('/var/lib/imp/a')).toBe('tank/imp/a');
});

test('it unmounts a mounted dir', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['mount', '-t', 'zfs', '-o', 'ro', 'tank/imp/a', '/var/lib/imp/a']);

  const result = await fake.run(['umount', '/var/lib/imp/a']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(fake.readMountedAt('/var/lib/imp/a')).toBeNull();
  expect(fake.isReadOnlyAt('/var/lib/imp/a')).toBeFalse();
});

test('it refuses to unmount a dir with no mount', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['umount', '/var/lib/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'umount: /var/lib/imp/a: not mounted.',
  });
});

test('it lists the tree oldest first in the -H tab format', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'destroy', '-d', 'tank/imp/a@one']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/b@two']);

  const result = await fake.run([
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

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: [
      'tank/imp\tfilesystem\t-\t-\n',
      'tank/imp/a\tfilesystem\t-\t-\n',
      'tank/imp/a@one\tsnapshot\t-\ton\n',
      'tank/imp/b\tfilesystem\ttank/imp/a@one\t-\n',
      'tank/imp/b@two\tsnapshot\t-\toff\n',
    ].join(''),
    stderr: '',
  });
});

test('it lists only the tree under the root given', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'create', 'tank/imp/ab']);
  await fake.run(['zfs', 'create', 'tank/imp/a/b']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/ab@one']);

  const result = await fake.run([
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
    'tank/imp/a',
  ]);

  expect(result.stdout).toBe('tank/imp/a\tfilesystem\t-\t-\ntank/imp/a/b\tfilesystem\t-\t-\n');
});

test('it lists space rows with a creation an hour after the fake epoch per txg', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/b']);
  await fake.run(['zfs', 'clone', 'tank/imp/a@one', 'tank/imp/c']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/b@two']);

  const result = await fake.run([
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

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: [
      'tank/imp\t1048576\t3145728\t1048576\t1790985600\t-\n',
      'tank/imp/a\t1048576\t3145728\t1048576\t1790989200\t-\n',
      'tank/imp/b\t1048576\t3145728\t1048576\t1790996400\t-\n',
      'tank/imp/c\t1048576\t3145728\t1048576\t1791000000\t-\n',
      'tank/imp/a@one\t65536\t1048576\t-\t1790992800\ttank/imp/b,tank/imp/c\n',
      'tank/imp/b@two\t65536\t1048576\t-\t1791003600\t-\n',
    ].join(''),
    stderr: '',
  });
});

test('it sets the fake epoch at midnight UTC on 2026-10-03', () => {
  expect(new Date(STUB_EPOCH_S * 1000).toISOString()).toBe('2026-10-03T00:00:00.000Z');
});

test('it reports the used and available bytes of a dataset', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'list', '-Hp', '-o', 'used,available', 'tank/imp']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '1073741824\t9663676416\n', stderr: '' });
});

test('it reports the bytes written to a snapshot', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const result = await fake.run(['zfs', 'get', '-Hp', '-o', 'value', 'written', 'tank/imp/a@one']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '65536\n', stderr: '' });
});

test('it refuses to read the bytes written to a snapshot that does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'get', '-Hp', '-o', 'value', 'written', 'tank/imp@one']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot open 'tank/imp@one': dataset does not exist",
  });
});

test('it prints the default userland and kernel versions', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'version']);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: 'zfs-2.2.2-0ubuntu9\nzfs-kmod-2.2.2-0ubuntu9\n',
    stderr: '',
  });
});

test('it prints the userland and kernel versions it was given', async () => {
  const fake = buildStubZfs({
    root: 'tank/imp',
    rootDir: '/var/lib/imp',
    userland: '2.3.1-1',
    kernel: '2.2.0-1',
  });

  const result = await fake.run(['zfs', 'version']);

  expect(result.stdout).toBe('zfs-2.3.1-1\nzfs-kmod-2.2.0-1\n');
});

test('it estimates every send stream at 1 MiB', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@two']);

  const result = await fake.run(['zfs', 'send', '-nP', '-i', 'tank/imp/a@one', 'tank/imp/a@two']);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: 'full\ttank/imp/a@two\t1048576\nsize\t1048576\n',
    stderr: '',
  });
});

test('it refuses a send estimate of a snapshot that does not exist', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'send', '-nP', 'tank/imp@one']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "cannot open 'tank/imp@one': dataset does not exist",
  });
});

test('it fails a command it does not know', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  const result = await fake.run(['zfs', 'upgrade', 'tank/imp']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'fake zfs: unknown command zfs upgrade tank/imp',
  });
});

test('it records each command it runs, streamed ones included', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  await new Response(fake.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']).stdout).text();

  expect(fake.commands).toStrictEqual([
    'zfs create tank/imp/a',
    'zfs snapshot tank/imp/a@one',
    'zfs send tank/imp/a@one',
  ]);
});

test('it receives a full stream as a new dataset with its snapshot', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const send = source.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']);

  await target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@one'], send.stdout);

  expect(target.listDatasets()).toStrictEqual(['cold/imp', 'cold/imp/a']);
  expect(target.listSnapshots()).toStrictEqual(['cold/imp/a@one']);
  expect(target.readOrigin('cold/imp/a')).toBeNull();
});

test('it receives an incremental stream onto the snapshot it is based on', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', 'cold/imp/a@one'],
    source.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']).stdout,
  );

  await source.run(['zfs', 'snapshot', 'tank/imp/a@two']);

  const send = source.streams.readFrom(['zfs', 'send', '-i', 'tank/imp/a@one', 'tank/imp/a@two']);

  await target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@two'], send.stdout);

  expect(target.listSnapshots()).toStrictEqual(['cold/imp/a@one', 'cold/imp/a@two']);
});

test('it receives a clone stream as a clone of the origin given', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/image']);
  await source.run(['zfs', 'snapshot', 'tank/imp/image@base']);
  await source.run(['zfs', 'clone', 'tank/imp/image@base', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@cp']);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', 'cold/imp/image@base'],
    source.streams.readFrom(['zfs', 'send', 'tank/imp/image@base']).stdout,
  );

  const send = source.streams.readFrom([
    'zfs',
    'send',
    '-i',
    'tank/imp/image@base',
    'tank/imp/a@cp',
  ]);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', '-o', 'origin=cold/imp/image@base', 'cold/imp/a@cp'],
    send.stdout,
  );

  expect(target.readOrigin('cold/imp/a')).toBe('cold/imp/image@base');
  expect(target.listSnapshots()).toStrictEqual(['cold/imp/a@cp', 'cold/imp/image@base']);
});

test('it refuses a full stream onto a dataset that exists', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await target.run(['zfs', 'create', 'cold/imp/a']);

  const send = source.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']);
  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@one'], send.stdout);

  expect(received).rejects.toThrowWithMessage(
    Error,
    "cannot receive new filesystem stream: destination 'cold/imp/a' exists",
  );
});

test('it refuses an incremental stream whose base is not the latest snapshot', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', 'cold/imp/a@one'],
    source.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']).stdout,
  );

  await target.run(['zfs', 'snapshot', 'cold/imp/a@local']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@two']);

  const send = source.streams.readFrom(['zfs', 'send', '-i', 'tank/imp/a@one', 'tank/imp/a@two']);
  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@two'], send.stdout);

  expect(received).rejects.toThrowWithMessage(
    Error,
    'cannot receive incremental stream: most recent snapshot of cold/imp/a does not match incremental source',
  );
});

test('it refuses a clone stream without an origin', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/image']);
  await source.run(['zfs', 'snapshot', 'tank/imp/image@base']);
  await source.run(['zfs', 'clone', 'tank/imp/image@base', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@cp']);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', 'cold/imp/image@base'],
    source.streams.readFrom(['zfs', 'send', 'tank/imp/image@base']).stdout,
  );

  const send = source.streams.readFrom([
    'zfs',
    'send',
    '-i',
    'tank/imp/image@base',
    'tank/imp/a@cp',
  ]);

  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@cp'], send.stdout);

  expect(received).rejects.toThrowWithMessage(
    Error,
    'cannot receive: local origin for clone cold/imp/a does not exist',
  );
});

test('it refuses a clone stream whose origin is not the stream base', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/image']);
  await source.run(['zfs', 'snapshot', 'tank/imp/image@base']);
  await source.run(['zfs', 'clone', 'tank/imp/image@base', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@cp']);
  await target.run(['zfs', 'create', 'cold/imp/image']);
  await target.run(['zfs', 'snapshot', 'cold/imp/image@base']);

  const send = source.streams.readFrom([
    'zfs',
    'send',
    '-i',
    'tank/imp/image@base',
    'tank/imp/a@cp',
  ]);

  const received = target.streams.writeTo(
    ['zfs', 'recv', '-u', '-o', 'origin=cold/imp/image@base', 'cold/imp/a@cp'],
    send.stdout,
  );

  expect(received).rejects.toThrowWithMessage(
    Error,
    'cannot receive: local origin for clone cold/imp/a does not exist',
  );
});

test('it refuses to send a snapshot that does not exist', () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  expect(() => fake.streams.readFrom(['zfs', 'send', 'tank/imp@one'])).toThrowWithMessage(
    Error,
    'fake zfs: zfs send tank/imp@one: no such snapshot',
  );
});

test('it receives nothing from a stream that ends before its end record', () => {
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  const input = new Response('{"guid":"0199a","baseG').body;

  invariant(input);

  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@one'], input);

  expect(received).rejects.toThrowWithMessage(Error, 'cannot receive: the stream ended early');
  expect(target.listDatasets()).toStrictEqual(['cold/imp']);
});

test('it commits a receive once the end record is in, though the input fails after', () => {
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  // the end record is in the first chunk; the next read fails
  const input = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('{"guid":"0199a","baseGuid":null}'));
    },
    pull: (controller) => {
      controller.error(new Error('ssh: connection reset'));
    },
  });

  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@one'], input);

  expect(received).rejects.toThrowWithMessage(Error, 'ssh: connection reset');
  expect(target.listSnapshots()).toStrictEqual(['cold/imp/a@one']);
});

test('it holds a matching command until it is released', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const release = fake.blockBefore((command) => command.startsWith('zfs create'));
  const held = fake.run(['zfs', 'create', 'tank/imp/a']);

  await fake.run(['zfs', 'version']);

  const whileHeld = fake.listDatasets();

  release();

  await held;

  expect(whileHeld).toStrictEqual(['tank/imp']);
  expect(fake.listDatasets()).toStrictEqual(['tank/imp', 'tank/imp/a']);
});

test('it fails the next matching command once and changes nothing', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  fake.failOnce((command) => command.startsWith('zfs create'));

  const result = await fake.run(['zfs', 'create', 'tank/imp/a']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'fake zfs: zfs create tank/imp/a failed',
  });

  expect(fake.listDatasets()).toStrictEqual(['tank/imp']);
});

test('it runs a matching command again after its one failure', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  fake.failOnce((command) => command.startsWith('zfs create'));

  await fake.run(['zfs', 'create', 'tank/imp/a']);

  const result = await fake.run(['zfs', 'create', 'tank/imp/a']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it throws a crash error instead of running the matching command', () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  fake.crashBefore((command) => command.startsWith('zfs create'));

  const result = fake.run(['zfs', 'create', 'tank/imp/a']);

  expect(result).rejects.toThrowWithMessage(
    StubZfsCrashError,
    'crashed before zfs create tank/imp/a',
  );

  expect(fake.listDatasets()).toStrictEqual(['tank/imp']);
});

test('it fails every command after a crash until a restart', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  fake.crashBefore((command) => command.startsWith('zfs create'));

  await fake.run(['zfs', 'create', 'tank/imp/a']).catch(() => null);

  const result = fake.run(['zfs', 'version']);

  expect(result).rejects.toThrowWithMessage(StubZfsCrashError, 'crashed before zfs version');
});

test('it runs commands again after a restart', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  fake.crashBefore((command) => command.startsWith('zfs create'));

  await fake.run(['zfs', 'create', 'tank/imp/a']).catch(() => null);

  fake.restart();

  const result = await fake.run(['zfs', 'create', 'tank/imp/a']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it keeps every mount through a restart of impd', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['mount', '-t', 'zfs', 'tank/imp/a', '/var/lib/imp/a']);

  fake.restart();

  expect(fake.readMountedAt('/var/lib/imp/a')).toBe('tank/imp/a');
});

test('it drops every mount but the root on a restart that drops mounts', async () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  await fake.run(['zfs', 'create', 'tank/imp/a']);
  await fake.run(['mount', '-t', 'zfs', 'tank/imp/a', '/var/lib/imp/a']);

  fake.restart(true);

  expect(fake.readMounts()).toBe('tank/imp /var/lib/imp zfs rw,noatime,xattr,noacl 0 0\n');
  expect(fake.listDatasets()).toStrictEqual(['tank/imp', 'tank/imp/a']);
});
