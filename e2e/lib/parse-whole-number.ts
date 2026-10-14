// A whole number a command printed; empty or other output throws, so a
// failed read never passes as 0.
export function parseWholeNumber(text: string, what: string): number {
  const trimmed = text.trim();

  if (!/^\d+$/v.test(trimmed)) {
    throw new Error(`${what}: not a whole number: ${JSON.stringify(text)}`);
  }

  return Number(trimmed);
}
