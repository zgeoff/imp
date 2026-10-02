const UNIT_MIB: Readonly<Record<string, number>> = { m: 1, g: 1024 };

// `2048`, `512m`, `2g`, `2GiB` → MiB; a bare number is MiB already
export function parseSize(text: string): number {
  const match = /^(?<amount>\d+)(?<unit>[mg])?(?:i?b)?$/i.exec(text.trim());
  const amount = Number(match?.groups?.['amount'] ?? 0);
  const unit = match?.groups?.['unit']?.toLowerCase() ?? 'm';

  if (amount === 0) {
    throw new Error(`not a size: ${text} (try 512m, 2g, or MiB as a whole number)`);
  }

  return amount * (UNIT_MIB[unit] ?? 1);
}

// a count such as --cpus: a whole number above zero
export function parseCount(text: string, flag: string): number {
  if (!/^\d+$/.test(text.trim()) || Number(text) === 0) {
    throw new Error(`--${flag} needs a whole number above 0, not ${text}`);
  }

  return Number(text);
}
