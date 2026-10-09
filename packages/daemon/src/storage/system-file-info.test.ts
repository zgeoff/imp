import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveFileSha256, parseKernelVersion, readKernelInfo } from './system-file-info';

test('#parseKernelVersion reads the release from the kernel banner', () => {
  // an ELF header, then the banner as a C string
  const image = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]),
    Buffer.from('Linux version 6.1.188 (imp@imp) (gcc (Ubuntu 11.4.0) 11.4.0) #1 SMP\0'),
  ]);

  expect(parseKernelVersion(image)).toBe('6.1.188');
});

test('#parseKernelVersion keeps a local version suffix', () => {
  expect(parseKernelVersion(Buffer.from('\u007FELF\0Linux version 6.1.188-imp\0\u0009'))).toBe(
    '6.1.188-imp',
  );
});

test('#parseKernelVersion reads no release from an image without a banner', () => {
  expect(parseKernelVersion(Buffer.from('\u007FELF\0not a kernel\0'))).toBeNull();
});

test('#readKernelInfo reads the kernel release and the sha256 of the whole image', () => {
  expect(readKernelInfo(Buffer.from('Linux version 6.1.188 (imp@imp)'))).toStrictEqual({
    version: '6.1.188',
    sha256: 'add71d53499921736be7d709dcbaa13b28f0e7a7e5922706c8a2150e877ba035',
  });
});

test('#deriveFileSha256 streams the sha256 of a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-system-files-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'imp-system.squashfs'), 'drive');

  const sha256 = await deriveFileSha256(join(dir, 'imp-system.squashfs'));

  expect(sha256).toBe('7062520c5a0ea9deac825278c9f4f0cbad48864b2c7d0c7f1ebccdb752afb058');
});
