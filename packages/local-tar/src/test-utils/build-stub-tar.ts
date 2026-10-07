import tar from 'tar-stream';
import type { Header } from 'tar-stream';

// One entry of a stub tar: its header, and the text a file holds.
export type StubTarEntry = Partial<Header> & {
  readonly name: string;
  readonly content?: string;
};

// The bytes of a tar holding these entries in order, as tar-stream packs
// them; a header field left out takes tar-stream's default.
export async function buildStubTar(entries: readonly StubTarEntry[]): Promise<Uint8Array> {
  const pack = tar.pack();

  for (const { content, ...header } of entries) {
    pack.entry(header, content ?? '');
  }

  pack.finalize();

  const chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  return new Uint8Array(Bun.concatArrayBuffers(chunks));
}
