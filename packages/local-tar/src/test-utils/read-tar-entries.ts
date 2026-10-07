import tar from 'tar-stream';
import type { Header } from 'tar-stream';

// tar-stream's header as extract gives it: its types say a string where an
// entry with no link target has null, and leave out the offset it adds
type ExtractedHeader = Omit<Header, 'linkname'> & {
  readonly linkname: unknown;
  readonly byteOffset?: unknown;
};

export interface TarEntry {
  readonly header: ExtractedHeader;

  // the entry's data, decoded as UTF-8
  readonly content: string;
}

// Every entry of the tar in these bytes, in order, with its data.
export async function readTarEntries(bytes: Uint8Array): Promise<TarEntry[]> {
  const extract = tar.extract();
  const entries: TarEntry[] = [];

  extract.end(bytes);

  for await (const entry of extract) {
    const chunks: Uint8Array[] = [];

    for await (const chunk of entry) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      }
    }

    entries.push({
      header: { ...entry.header },
      content: new TextDecoder().decode(Bun.concatArrayBuffers(chunks)),
    });
  }

  return entries;
}
