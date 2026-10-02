import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// bytes through an imp's tap, as the guest sees them
export interface GuestNetBytes {
  readonly rxBytes: number;
  readonly txBytes: number;
}

// The host's counters on the tap are the other way round: what the host
// receives on it is what the guest sent. Null when the tap is gone.
export function readGuestNetBytes(tap: string, sysRoot = '/sys'): GuestNetBytes | null {
  const statistics = join(sysRoot, 'class', 'net', tap, 'statistics');

  try {
    const hostRx = Number(readFileSync(join(statistics, 'rx_bytes'), 'utf8'));
    const hostTx = Number(readFileSync(join(statistics, 'tx_bytes'), 'utf8'));

    return { rxBytes: hostTx, txBytes: hostRx };
  } catch {
    return null;
  }
}
