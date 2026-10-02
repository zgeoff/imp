import { expect, test } from 'bun:test';
import type { ImpState } from '@imp/api';
import { countBootStatuses } from './boot-status';
import type { BootStatus } from './boot-status';

interface StatusCase {
  readonly state: ImpState;
  readonly status: BootStatus;
}

function count(cases: readonly StatusCase[]) {
  const read: StatusCase[] = [];

  const counts = countBootStatuses(cases, (imp) => {
    read.push(imp);

    return imp.status;
  });

  return { counts, read };
}

test('a sleeping imp with a reason boots cold; one whose snapshot loads counts its old parts', () => {
  const result = count([
    { state: 'sleeping', status: { coldBootReason: 'firecrackerVersion changed' } },
    { state: 'sleeping', status: { coldBootReason: 'no snapshot it can load' } },
    { state: 'sleeping', status: { outdated: ['agent', 'kernel'] } },
    { state: 'sleeping', status: {} },
  ]);

  expect(result.counts).toEqual({
    coldBoots: 2,
    outdated: { firecracker: 0, kernel: 1, agent: 1 },
  });
});

test('a running imp boots cold next when it runs an older firecracker or impd booted it without an identity', () => {
  const result = count([
    { state: 'running', status: { outdated: ['firecracker'] } },
    { state: 'running', status: { outdated: ['impd'] } },
    { state: 'running', status: { outdated: ['agent'] } },
    { state: 'running', status: { outdated: ['kernel', 'agent'] } },
  ]);

  expect(result.counts).toEqual({
    coldBoots: 2,
    outdated: { firecracker: 1, kernel: 1, agent: 2 },
  });
});

test('a running imp whose last boot was cold does not boot cold again for that', () => {
  const result = count([
    { state: 'running', status: { coldBootReason: 'its agent drive d1d1d1d1d1d1 is gone' } },
  ]);

  expect(result.counts).toEqual({
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 0, agent: 0 },
  });
});

test('stopped, failed and creating imps are never read or counted', () => {
  const outdated: BootStatus = {
    coldBootReason: 'no snapshot it can load',
    outdated: ['firecracker'],
  };

  const result = count([
    { state: 'stopped', status: outdated },
    { state: 'error', status: outdated },
    { state: 'creating', status: outdated },
  ]);

  expect(result.read).toEqual([]);

  expect(result.counts).toEqual({
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 0, agent: 0 },
  });
});
