// the body as text, of at most `max` bytes; null for none or a larger one
export async function readBodyText(request: Request, max: number): Promise<string | null> {
  if (request.body === null) {
    return null;
  }

  const body: ReadableStream<Uint8Array> = request.body;
  const chunks: Uint8Array[] = [];
  let total = 0;

  // leaving the loop early cancels the rest of the body
  for await (const chunk of body) {
    total += chunk.byteLength;

    if (total > max) {
      return null;
    }

    chunks.push(chunk);
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}
