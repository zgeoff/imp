const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

// binary units, with one decimal below 100: "512 B", "1.5 KiB", "300 MiB"
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit === 0 || value >= 100 ? 0 : 1;

  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`;
}
