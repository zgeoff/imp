import type { Imp } from '@impz/client';
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

  if (imp.inner?.up === false) {
    const restarts =
      imp.inner.restarts === 1 ? '1 restart' : `${String(imp.inner.restarts)} restarts`;

    const why = imp.inner.lastError === undefined ? '' : `: ${imp.inner.lastError}`;

    notes.push({ tone: 'error', text: `container down after ${restarts}${why}` });
  }

  if (imp.coldBootReason !== undefined) {
    const text =
      imp.state === 'sleeping'
        ? `next wake boots cold: ${imp.coldBootReason}`
        : `last boot was cold: ${imp.coldBootReason}`;

    notes.push({ tone: imp.state === 'sleeping' ? 'warning' : 'info', text });
  }

  const parts = (imp.outdated ?? []).filter((part) => part !== 'ipv6');

  if (parts.length > 0) {
    notes.push({ tone: 'warning', text: `runs an older ${parts.join(', ')}` });
  }

  if (imp.outdated?.includes('ipv6') === true) {
    notes.push({ tone: 'info', text: 'no IPv6 until its next cold boot' });
  }

  return notes;
}
