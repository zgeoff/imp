const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };

// `90`, `90s`, `15m`, `2h`, `1d` → seconds
export function parseDuration(text: string): number {
  const match = /^(?<amount>\d+)(?<unit>[smhd]?)$/.exec(text.trim());
  const amount = match?.groups?.['amount'];
  const unit = match?.groups?.['unit'] ?? '';

  if (amount === undefined) {
    throw new Error(`not a duration: ${text} (try 90s, 15m, 2h)`);
  }

  return Number(amount) * (UNIT_SECONDS[unit] ?? 1);
}
