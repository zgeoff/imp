// the chunks, in order, as one array
export function mergeBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));

  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);

    offset += chunk.byteLength;
  }

  return merged;
}
