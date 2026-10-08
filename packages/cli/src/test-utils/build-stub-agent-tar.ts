import tar from 'tar-stream';
import type { Header } from 'tar-stream';

// one entry: its tar header, and for a file its content
export type StubTarEntry = Partial<Header> & Pick<Header, 'name'> & { readonly content?: string };

// The tar `imp-agent tar create` sends from an imp, for `imp cp` to
// extract: a file is 0644 and anything else 0755 unless its header says
// otherwise, and an entry with content is a file.
export async function buildStubAgentTar(
  entries: readonly Readonly<StubTarEntry>[],
): Promise<Uint8Array> {
  const pack = tar.pack();

  for (const { content, ...header } of entries) {
    if (content === undefined) {
      pack.entry({ mode: 0o755, ...header });
    } else {
      pack.entry({ mode: 0o644, type: 'file', ...header }, content);
    }
  }

  pack.finalize();

  const chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  return Buffer.concat(chunks);
}
