import { formatBytes } from './format-bytes';

// a size given in MiB, as formatBytes writes it: "300 MiB", "2.0 GiB"
export function formatMib(mib: number): string {
  return formatBytes(mib * 1024 * 1024);
}
