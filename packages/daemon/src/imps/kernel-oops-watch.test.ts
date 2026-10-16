import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernelOopsWatch } from './kernel-oops-watch';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-taint-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // where the test writes the kernel's taint mask, as /proc/sys/kernel/tainted,
  // its boot id, as /proc/sys/kernel/random/boot_id, its log, as /dev/kmsg,
  // and impd's PID namespace, as /proc/self/ns/pid
  return {
    taintPath: join(dir, 'tainted'),
    bootIdPath: join(dir, 'boot_id'),
    kmsgPath: join(dir, 'kmsg'),
    pidNamespacePath: join(dir, 'pid'),
  };
}

test('it reads a clear taint mask as no oops', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeFalse();
});

test('it reads taint flag D as an oops', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '128\n');

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeTrue();
});

test('it reads flag D among other taint flags as an oops', () => {
  const ctx = setupTest();

  // D with O (an out-of-tree module, as zfs is) and E (unsigned)
  writeFileSync(ctx.taintPath, `${String(128 + 4096 + 8192)}\n`);

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeTrue();
});

test('it reads other taint flags without D as no oops', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, `${String(4096 + 8192)}\n`);

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeFalse();
});

test('it reads a missing taint file as no oops', () => {
  const ctx = setupTest();

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeFalse();
});

test('it reads a malformed taint file as no oops', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, 'tainted\n');

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeFalse();
});

test('it reads the flag clear from a taint mask without D', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, `${String(4096)}\n`);

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('clear');
});

test('it reads the flag set from a taint mask with D', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, `${String(128 + 4096)}\n`);

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('set');
});

test('it reads the flag unknown from a missing taint file', () => {
  const ctx = setupTest();

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('unknown');
});

test('it reads the flag unknown from a taint file it cannot read', () => {
  const ctx = setupTest();

  // a directory where the file should be: the read fails with EISDIR
  mkdirSync(ctx.taintPath);

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('unknown');
});

test('it reads the flag unknown from a malformed taint file', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, 'tainted\n');

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('unknown');
});

test('it reads the flag unknown from a taint mask too large to hold its low bits', () => {
  const ctx = setupTest();

  // 2^60 + 128: as a double, the low bits and flag D among them round away
  writeFileSync(ctx.taintPath, '1152921504606847104\n');

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('unknown');
});

test('it reads the flag clear once the file reads clear after an unknown read', () => {
  const ctx = setupTest();
  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.readFlag();

  writeFileSync(ctx.taintPath, '0\n');

  expect(watch.readFlag()).toBe('clear');
});

test('it finds when it first read the flag set after it read the flag clear', () => {
  const ctx = setupTest();
  const clock = { nowMs: 1000 };

  writeFileSync(ctx.taintPath, '0\n');

  const watch = createKernelOopsWatch(ctx.taintPath, () => clock.nowMs);

  watch.isOopsed();

  writeFileSync(ctx.taintPath, '128\n');

  clock.nowMs = 2000;

  watch.isOopsed();

  clock.nowMs = 3000;

  expect(watch.findOopsSeenAt()).toBe(2000);
});

test('it finds no oops since clear when the flag was set at the first read', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '128\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  expect(watch.findOopsSeenAt()).toBeNull();
});

test('it finds no oops since clear while the flag stays clear', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  expect(watch.findOopsSeenAt()).toBeNull();
});

test('it keeps an oops it saw once the file reads clear again', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '128\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  // the kernel never clears D; a read that says so is not a reboot
  writeFileSync(ctx.taintPath, '0\n');

  expect(watch.isOopsed()).toBeTrue();
});

test('it reads the boot id the kernel gives this boot', () => {
  const ctx = setupTest();

  writeFileSync(ctx.bootIdPath, '6b1f0c3e-92d4-4a7b-8e5f-0d2c4a6b8e1f\n');

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath);

  expect(watch.findBootId()).toBe('6b1f0c3e-92d4-4a7b-8e5f-0d2c4a6b8e1f');
});

test('it finds no boot id without the boot id file', () => {
  const ctx = setupTest();
  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath);

  expect(watch.findBootId()).toBeNull();
});

test('it finds no boot id in a file that holds no UUID', () => {
  const ctx = setupTest();

  writeFileSync(ctx.bootIdPath, 'booted\n');

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath);

  expect(watch.findBootId()).toBeNull();
});

test('it keeps the first boot id it read', () => {
  const ctx = setupTest();

  writeFileSync(ctx.bootIdPath, '6b1f0c3e-92d4-4a7b-8e5f-0d2c4a6b8e1f\n');

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath);

  watch.findBootId();

  // a boot keeps its id; a read that says otherwise is not a reboot
  writeFileSync(ctx.bootIdPath, 'c47a9e20-1b3d-4f68-a5c2-7e9d0b1f3a54\n');

  expect(watch.findBootId()).toBe('6b1f0c3e-92d4-4a7b-8e5f-0d2c4a6b8e1f');
});

test('it finds the imp whose Firecracker owned the thread an oops killed', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.kmsgPath,
    [
      '1,812,90412345,-;BUG: unable to handle page fault for address: ffffc90000a3f000',
      '1,813,90412350,-;#PF: supervisor read access in kernel mode',
      '4,814,90412360,-;Oops: 0000 [#1] PREEMPT SMP NOPTI',
      '4,815,90412365,-;CPU: 3 PID: 4242 Comm: fc_vcpu 0 Tainted: P           O       6.8.0-45-generic #45-Ubuntu',
      '4,816,90412370,-;Hardware name: QEMU Standard PC (Q35 + ICH9, 2009)',
      '',
    ].join('\n'),
  );

  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(watch.findOopsOwners((thread) => (thread === 4242 ? ['a'] : []))).toStrictEqual(
    new Set(['a']),
  );
});

test('it reads the task line of a kernel that puts the UID before the PID', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.kmsgPath,
    [
      '4,814,90412360,-;Oops: general protection fault, probably for non-canonical address 0xdead000000000100: 0000 [#1] PREEMPT SMP NOPTI',
      '4,815,90412365,-;CPU: 3 UID: 0 PID: 4242 Comm: fc_vcpu 0 Tainted: P           O       6.17.0-5-generic #5-Ubuntu',
      '',
    ].join('\n'),
  );

  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(watch.findOopsOwners((thread) => (thread === 4242 ? ['a'] : []))).toStrictEqual(
    new Set(['a']),
  );
});

test('it finds the owners of each oops since boot', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.kmsgPath,
    [
      '4,814,90412360,-;Oops: 0000 [#1] PREEMPT SMP NOPTI',
      '4,815,90412365,-;CPU: 3 PID: 4242 Comm: fc_vcpu 0 Tainted: P           O       6.8.0-45-generic #45-Ubuntu',
      '4,901,95000000,-;Oops: 0002 [#2] PREEMPT SMP NOPTI',
      '4,902,95000005,-;CPU: 1 PID: 5151 Comm: fc_vcpu 1 Tainted: P      D    O       6.8.0-45-generic #45-Ubuntu',
      '',
    ].join('\n'),
  );

  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(
    watch.findOopsOwners(
      (thread) =>
        new Map([
          [4242, ['a']],
          [5151, ['b']],
        ]).get(thread) ?? [],
    ),
  ).toStrictEqual(new Set(['a', 'b']));
});

test('it reads past the dictionary lines under a record and a warning before the oops', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.kmsgPath,
    [
      '4,700,80000000,-;WARNING: CPU: 2 PID: 3131 at fs/inode.c:330 drop_nlink+0x3e/0x50',
      '4,701,80000005,c;CPU: 2 PID: 3131 Comm: rm Tainted: P           O       6.8.0-45-generic #45-Ubuntu',
      ' SUBSYSTEM=cpu',
      ' DEVICE=+cpu:cpu2',
      '4,814,90412360,-;Oops: 0000 [#1] PREEMPT SMP NOPTI',
      '4,815,90412365,-;CPU: 3 PID: 4242 Comm: fc_vcpu 0 Tainted: P        W  O       6.8.0-45-generic #45-Ubuntu',
      '',
    ].join('\n'),
  );

  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(
    watch.findOopsOwners(
      (thread) =>
        new Map([
          [4242, ['a']],
          [3131, ['b']],
        ]).get(thread) ?? [],
    ),
  ).toStrictEqual(new Set(['a']));
});

test('it finds no owners for an oops that killed a thread no VM owned', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.kmsgPath,
    [
      '4,814,90412360,-;Oops: 0000 [#1] PREEMPT SMP NOPTI',
      '4,815,90412365,-;CPU: 1 PID: 7777 Comm: z_rd_int Tainted: P           O       6.8.0-45-generic #45-Ubuntu',
      '',
    ].join('\n'),
  );

  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(watch.findOopsOwners((thread) => (thread === 4242 ? ['a'] : []))).toBeNull();
});

test('it finds no owners when it cannot read the kernel log', () => {
  const ctx = setupTest();

  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(watch.findOopsOwners(() => ['a'])).toBeNull();
});

test('it finds no owners when the kernel log has dropped the first oops', () => {
  const ctx = setupTest();

  // the log filled and lost oops #1, which may have hit another VM
  writeFileSync(
    ctx.kmsgPath,
    [
      '4,901,95000000,-;Oops: 0002 [#2] PREEMPT SMP NOPTI',
      '4,902,95000005,-;CPU: 1 PID: 5151 Comm: fc_vcpu 1 Tainted: P      D    O       6.8.0-45-generic #45-Ubuntu',
      '',
    ].join('\n'),
  );

  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(watch.findOopsOwners((thread) => (thread === 5151 ? ['b'] : []))).toBeNull();
});

test('it finds no owners for an oops whose task line the log has lost', () => {
  const ctx = setupTest();

  writeFileSync(ctx.kmsgPath, '4,814,90412360,-;Oops: 0000 [#1] PREEMPT SMP NOPTI\n');
  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(watch.findOopsOwners(() => ['a'])).toBeNull();
});

test('it keeps the owners it first found for an oops after their VM leaves the sampler', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.kmsgPath,
    [
      '4,814,90412360,-;Oops: 0000 [#1] PREEMPT SMP NOPTI',
      '4,815,90412365,-;CPU: 3 PID: 4242 Comm: fc_vcpu 0 Tainted: P           O       6.8.0-45-generic #45-Ubuntu',
      '',
    ].join('\n'),
  );

  symlinkSync('pid:[4026531836]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  watch.findOopsOwners((thread) => (thread === 4242 ? ['a'] : []));

  expect(watch.findOopsOwners(() => [])).toStrictEqual(new Set(['a']));
});

test('it finds no owners when impd runs outside the host PID namespace', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.kmsgPath,
    [
      '4,814,90412360,-;Oops: 0000 [#1] PREEMPT SMP NOPTI',
      '4,815,90412365,-;CPU: 3 PID: 4242 Comm: fc_vcpu 0 Tainted: P           O       6.8.0-45-generic #45-Ubuntu',
      '',
    ].join('\n'),
  );

  // a container's namespace: the log's 4242 is another thread there
  symlinkSync('pid:[4026532109]', ctx.pidNamespacePath);

  const watch = createKernelOopsWatch(ctx.taintPath, Date.now, ctx.bootIdPath, {
    kmsgPath: ctx.kmsgPath,
    pidNamespacePath: ctx.pidNamespacePath,
  });

  expect(watch.findOopsOwners((thread) => (thread === 4242 ? ['a'] : []))).toBeNull();
});
