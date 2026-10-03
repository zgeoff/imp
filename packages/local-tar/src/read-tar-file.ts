import { createReadStream } from 'node:fs';
import { posix } from 'node:path';
import tar from 'tar-stream';

// the name as `posix.normalize` gives it: `./Dockerfile` and `Dockerfile`
// are the same entry
function normalizeName(name: string): string {
  return posix.normalize(name).replace(/\/$/v, '');
}

// The text of the regular file `name` in the tar at `path`, or null when
// the tar has no such file. A file over maxBytes is an error.
export async function readTarFile(
  path: string,
  name: string,
  maxBytes: number,
): Promise<string | null> {
  const wanted = normalizeName(name);
  const extract = tar.extract();

  createReadStream(path).pipe(extract);

  for await (const entry of extract) {
    if (entry.header.type !== 'file' || normalizeName(entry.header.name) !== wanted) {
      entry.resume();
      continue;
    }

    if ((entry.header.size ?? 0) > maxBytes) {
      extract.destroy();
      throw new Error(`${name} in the tar is larger than ${String(maxBytes)} bytes`);
    }

    const chunks: Uint8Array[] = [];

    for await (const chunk of entry) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      }
    }

    extract.destroy();

    return new TextDecoder().decode(Bun.concatArrayBuffers(chunks));
  }

  return null;
}
