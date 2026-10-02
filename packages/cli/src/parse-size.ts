import { UsageError } from './usage-error';

const UNIT_MIB: Readonly<Record<string, number>> = { m: 1, g: 1024, t: 1024 * 1024 };

// `2048`, `512m`, `2g`, `2GiB`, `1t` → MiB; a bare number is MiB already
export function parseSize(text: string): number {
  const match = /^(?<amount>\d+)(?:(?<unit>[mgt])(?:i?b)?)?$/i.exec(text.trim());
  const amount = Number(match?.groups?.['amount'] ?? 0);
  const unit = match?.groups?.['unit']?.toLowerCase() ?? 'm';

  if (amount === 0) {
    throw new UsageError(`not a size: ${text} (try 512m, 2g, 1t, or MiB as a whole number)`);
  }

  return amount * (UNIT_MIB[unit] ?? 1);
}

// a count such as --cpus: a whole number above zero
export function parseCount(text: string, flag: string): number {
  if (!/^\d+$/.test(text.trim()) || Number(text) === 0) {
    throw new UsageError(`--${flag} needs a whole number above 0, not ${text}`);
  }

  return Number(text);
}
