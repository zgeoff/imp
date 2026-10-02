import { readFileSync } from 'node:fs';

// What `system.info` reports about the guest kernel and the system drive
// impd boots imps with: enough to tell which release they came from.
export interface SystemFileInfo {
  readonly guestKernel: { readonly version: string | null; readonly sha256: string };
  readonly systemDrive: { readonly sha256: string };
}

interface SystemFilePaths {
  readonly kernelPath: string;
  readonly systemDrivePath: string;
}

const BANNER = Buffer.from('Linux version ');

// Read once at start, after setupSystemFiles: impd swaps the files only then.
export function readSystemFileInfo(paths: Readonly<SystemFilePaths>): SystemFileInfo {
  const kernel = readFileSync(paths.kernelPath);

  return {
    guestKernel: { version: parseKernelVersion(kernel), sha256: deriveSha256(kernel) },
    systemDrive: { sha256: deriveSha256(readFileSync(paths.systemDrivePath)) },
  };
}

// The release from the banner every kernel image carries
// ("Linux version 6.1.188 (imp@imp) ..."), or null without one.
export function parseKernelVersion(image: Uint8Array): string | null {
  const start = Buffer.from(image.buffer, image.byteOffset, image.byteLength).indexOf(BANNER);

  if (start === -1) {
    return null;
  }

  // the banner is a C string: stop at its NUL
  const tail = Buffer.from(image.subarray(start + BANNER.length, start + BANNER.length + 64));
  const [text = ''] = tail.toString('latin1').split('\0');
  const match = /^\S+/.exec(text);

  return match?.[0] ?? null;
}

function deriveSha256(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}
