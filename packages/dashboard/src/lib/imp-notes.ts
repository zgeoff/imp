import type { Imp } from '@zgeoff/imp-client';
import { formatRelativeTime } from './format';

export interface ImpNote {
  readonly tone: 'error' | 'warning' | 'info';
  readonly text: string;
}

// What is worth knowing about an imp beyond its state: why it failed, why
// its next wake boots cold, and whether a hold keeps it awake.
export function buildImpNotes(imp: Imp, nowMs: number): ImpNote[] {
  const notes: ImpNote[] = [];

  if (imp.error !== undefined) {
    notes.push({ tone: 'error', text: imp.error });
  }

  if (imp.holdUntil !== undefined && imp.holdUntil.getTime() > nowMs) {
    notes.push({
      tone: 'info',
      text: `held awake, ends ${formatRelativeTime(imp.holdUntil, nowMs)}`,
    });
  }

  if (imp.agentSilentSince !== undefined) {
    notes.push({
      tone: 'warning',
      text: `agent not answering since ${formatRelativeTime(imp.agentSilentSince, nowMs)}`,
    });
  }

  if (imp.coldBootReason !== undefined) {
    const text =
      imp.state === 'sleeping'
        ? `next wake boots cold: ${imp.coldBootReason}`
        : `last boot was cold: ${imp.coldBootReason}`;

    notes.push({ tone: imp.state === 'sleeping' ? 'warning' : 'info', text });
  }

  if (imp.outdated !== undefined && imp.outdated.length > 0) {
    notes.push({ tone: 'warning', text: `runs an older ${imp.outdated.join(', ')}` });
  }

  return notes;
}
