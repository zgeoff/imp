import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKernelVersion, readSystemFileInfo } from './system-file-info';

function buildImage(text: string): Uint8Array {
  return new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, ...Buffer.from(text), 0, 9]);
}

test('it reads the release from the kernel banner', () => {
  const image = buildImage('Linux version 6.1.188 (imp@imp) (gcc (Ubuntu 11.4.0) 11.4.0) #1 SMP');

  expect(parseKernelVersion(image)).toBe('6.1.188');
});

test('it keeps a local version suffix', () => {
  expect(parseKernelVersion(buildImage('Linux version 6.1.188-imp\0'))).toBe('6.1.188-imp');
});

test('it returns null for an image without a banner', () => {
  expect(parseKernelVersion(buildImage('not a kernel'))).toBeNull();
});

test('it reads the kernel version and the sha256 of both files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-system-files-'));

  try {
    const kernelPath = join(dir, 'vmlinux');
    const systemDrivePath = join(dir, 'imp-system.squashfs');

    writeFileSync(kernelPath, buildImage('Linux version 6.1.188 (imp@imp)'));
    writeFileSync(systemDrivePath, 'drive');

    const info = readSystemFileInfo({ kernelPath, systemDrivePath });

    expect(info.guestKernel.version).toBe('6.1.188');
    expect(info.guestKernel.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(info.systemDrive.sha256).toBe(
      '7062520c5a0ea9deac825278c9f4f0cbad48864b2c7d0c7f1ebccdb752afb058',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
