import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The CPU a guest kernel picked its code paths on: a memory snapshot loads
// only on the same model with the same CPUID flags
// (docs/architecture/sleep-and-wake.md#the-cpu)
export interface CpuIdentity {
  readonly cpuModel: string;

  // sha256 of the flags, sorted, so their order in /proc/cpuinfo does not count
  readonly cpuFlags: string;
}

export const UNKNOWN_CPU = 'unknown';

// The first processor's model and flags; arm64 names them `CPU part` and
// `Features`. A CPU it cannot read is `unknown`: a move refuses it.
export function parseCpuInfo(text: string): CpuIdentity {
  const first = text.split(/\n\s*\n/)[0] ?? '';

  const fields = new Map<string, string>();

  for (const line of first.split('\n')) {
    const at = line.indexOf(':');

    if (at !== -1) {
      fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }

  const model = fields.get('model name') ?? fields.get('CPU part') ?? UNKNOWN_CPU;
  const flags = fields.get('flags') ?? fields.get('Features');

  if (flags === undefined) {
    return { cpuModel: model, cpuFlags: UNKNOWN_CPU };
  }

  const sorted = flags.split(/\s+/).filter(Boolean).toSorted().join(' ');

  return { cpuModel: model, cpuFlags: createHash('sha256').update(sorted).digest('hex') };
}

export function readCpuIdentity(path = '/proc/cpuinfo'): CpuIdentity {
  try {
    return parseCpuInfo(readFileSync(path, 'utf8'));
  } catch {
    return { cpuModel: UNKNOWN_CPU, cpuFlags: UNKNOWN_CPU };
  }
}

// why a snapshot from one CPU cannot load on another, or null; a snapshot
// without the CPU, from an older impd, loads as it did before
export function findCpuChange(
  snapshot: Readonly<{ cpuModel?: string | undefined; cpuFlags?: string | undefined }>,
  host: Readonly<CpuIdentity>,
): string | null {
  if (snapshot.cpuModel !== undefined && snapshot.cpuModel !== host.cpuModel) {
    return `the CPU changed (${snapshot.cpuModel} → ${host.cpuModel})`;
  }

  if (snapshot.cpuFlags !== undefined && snapshot.cpuFlags !== host.cpuFlags) {
    return 'the CPU flags changed';
  }

  return null;
}
