// What `system.info` reports about the guest kernel and the system drive
// impd boots imps with: enough to tell which release they came from.
export interface SystemFileInfo {
  readonly guestKernel: { readonly version: string | null; readonly sha256: string };
  readonly systemDrive: { readonly sha256: string };
}

const BANNER = Buffer.from('Linux version ');

// a kernel image is small and read whole for its banner anyway
export function readKernelInfo(image: Uint8Array): SystemFileInfo['guestKernel'] {
  return { version: parseKernelVersion(image), sha256: deriveSha256(image) };
}

// streamed: a system drive can be large
export async function deriveFileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');

  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }

  return hasher.digest('hex');
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

export function deriveSha256(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}
