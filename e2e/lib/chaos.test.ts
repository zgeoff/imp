import { expect, test } from 'bun:test';
import {
  CHAOS_EXEC_S,
  createParkMiller,
  findLostImps,
  findStrayVms,
  findUnsettledImps,
  listExpectedImpVmCounts,
  listImpVmCounts,
  parseFirecrackerVms,
  pickFaultVictim,
  pickOne,
  planChaosRound,
} from './chaos';

test('#createParkMiller gives the minimal standard sequence from state 1 for seed 0', () => {
  const random = createParkMiller(0);

  expect([random() * 2_147_483_647, random() * 2_147_483_647]).toStrictEqual([48_271, 182_605_794]);
});

test('#createParkMiller replays the same sequence for the same seed', () => {
  const first = createParkMiller(424_242);
  const second = createParkMiller(424_242);

  expect([first(), first(), first()]).toStrictEqual([second(), second(), second()]);
});

test('#pickOne picks the item the draw lands on', () => {
  expect(pickOne(() => 0.5, ['a', 'b', 'c'])).toBe('b');
});

test('#pickOne throws on no items', () => {
  expect(() => pickOne(() => 0.5, [])).toThrowWithMessage(RangeError, 'nothing to pick from');
});

test('#planChaosRound plans a held exec, the other steps, the fault and the delay from the draws', () => {
  const draws = [0.5, 0.7, 0.3, 0.1, 0.9, 0.7, 0.2, 0.4];
  const readNextDraw = () => draws.shift() ?? 0;

  expect(planChaosRound(readNextDraw, ['e2e-chaos-a', 'e2e-chaos-b'], new Set())).toStrictEqual({
    steps: [
      { op: 'exec', name: 'e2e-chaos-b' },
      { op: 'wake', name: 'e2e-chaos-a' },
      { op: 'stop-start', name: 'e2e-chaos-a' },
    ],
    fault: 'impd',
    delayMs: 1200,
  });
});

test('#planChaosRound keeps the other steps off the held exec’s imp', () => {
  expect(
    planChaosRound(() => 0.9999, ['e2e-chaos-a', 'e2e-chaos-b'], new Set()).steps,
  ).toStrictEqual([
    { op: 'exec', name: 'e2e-chaos-b' },
    { op: 'stop-start', name: 'e2e-chaos-a' },
    { op: 'stop-start', name: 'e2e-chaos-a' },
  ]);
});

test('#planChaosRound plans only the held exec when one imp is left', () => {
  expect(planChaosRound(() => 0.9999, ['e2e-chaos-a'], new Set()).steps).toStrictEqual([
    { op: 'exec', name: 'e2e-chaos-a' },
  ]);
});

test('#planChaosRound holds its exec on an imp not in error', () => {
  expect(
    planChaosRound(() => 0, ['e2e-chaos-a', 'e2e-chaos-b', 'e2e-chaos-c'], new Set(['e2e-chaos-a']))
      .steps,
  ).toStrictEqual([{ op: 'exec', name: 'e2e-chaos-b' }]);
});

test('#planChaosRound runs the other steps on an imp in error', () => {
  // the held exec's imp, the step count, then each step's op and imp
  const draws = [0, 0.5, 0, 0];
  const readNextDraw = () => draws.shift() ?? 0;

  expect(
    planChaosRound(
      readNextDraw,
      ['e2e-chaos-a', 'e2e-chaos-b', 'e2e-chaos-c'],
      new Set(['e2e-chaos-a']),
    ).steps,
  ).toStrictEqual([
    { op: 'exec', name: 'e2e-chaos-b' },
    { op: 'sleep', name: 'e2e-chaos-a' },
  ]);
});

test('#planChaosRound throws when every imp is in error', () => {
  expect(() =>
    planChaosRound(() => 0, ['e2e-chaos-a'], new Set(['e2e-chaos-a'])),
  ).toThrowWithMessage(RangeError, 'nothing to pick from');
});

test('#planChaosRound holds its exec past the latest fault offset', () => {
  expect(CHAOS_EXEC_S * 1000).toBeGreaterThan(
    planChaosRound(() => 0.9999, ['e2e-chaos-a', 'e2e-chaos-b'], new Set()).delayMs,
  );
});

test('#pickFaultVictim picks among the imps whose VM runs', () => {
  const idsByName = new Map([
    ['e2e-chaos-a', 'id-a'],
    ['e2e-chaos-b', 'id-b'],
    ['e2e-chaos-c', 'id-c'],
  ]);

  const vms = new Map([
    ['id-a', [101]],
    ['id-c', [103]],
  ]);

  expect(
    pickFaultVictim(() => 0.9, ['e2e-chaos-a', 'e2e-chaos-b', 'e2e-chaos-c'], idsByName, vms),
  ).toBe('e2e-chaos-c');
});

test('#pickFaultVictim finds no victim when no VM runs', () => {
  expect(
    pickFaultVictim(() => 0.5, ['e2e-chaos-a'], new Map([['e2e-chaos-a', 'id-a']]), new Map()),
  ).toBeNull();
});

test('#listImpVmCounts lists each imp’s state and its VMs', () => {
  expect(
    listImpVmCounts(
      [
        { id: 'id-a', name: 'e2e-chaos-a', state: 'running' },
        { id: 'id-b', name: 'e2e-chaos-b', state: 'sleeping' },
      ],
      new Map([['id-a', [101, 102]]]),
    ),
  ).toStrictEqual(['e2e-chaos-a running: 2 VMs', 'e2e-chaos-b sleeping: 0 VMs']);
});

test('#listExpectedImpVmCounts expects one VM while running or in error with a VM left, and none otherwise', () => {
  expect(
    listExpectedImpVmCounts(
      [
        { id: 'id-a', name: 'e2e-chaos-a', state: 'running' },
        { id: 'id-b', name: 'e2e-chaos-b', state: 'error' },
        { id: 'id-c', name: 'e2e-chaos-c', state: 'error' },
        { id: 'id-d', name: 'e2e-chaos-d', state: 'sleeping' },
      ],
      new Map([
        ['id-b', [102]],
        ['id-d', [104]],
      ]),
    ),
  ).toStrictEqual([
    'e2e-chaos-a running: 1 VMs',
    'e2e-chaos-b error: 1 VMs',
    'e2e-chaos-c error: 0 VMs',
    'e2e-chaos-d sleeping: 0 VMs',
  ]);
});

test('#findStrayVms finds the VMs no imp owns', () => {
  expect(
    findStrayVms(
      [{ id: 'id-a', name: 'e2e-chaos-a', state: 'running' }],
      new Map([
        ['id-a', [101]],
        ['id-x', [199]],
      ]),
    ),
  ).toStrictEqual(['id-x']);
});

test('#findUnsettledImps finds the imps mid-transition or missing', () => {
  expect(
    findUnsettledImps(
      [
        { id: 'id-a', name: 'e2e-chaos-a', state: 'running' },
        { id: 'id-b', name: 'e2e-chaos-b', state: 'waking' },
        { id: 'id-c', name: 'e2e-chaos-c', state: 'error' },
      ],
      ['e2e-chaos-a', 'e2e-chaos-b', 'e2e-chaos-c', 'e2e-chaos-d'],
    ),
  ).toStrictEqual(['e2e-chaos-b', 'e2e-chaos-d']);
});

test('#findLostImps counts every step cut by an impd kill, and what the fault took', () => {
  expect(
    findLostImps(
      {
        steps: [
          { op: 'exec', name: 'e2e-chaos-a' },
          { op: 'sleep', name: 'e2e-chaos-b' },
        ],
        fault: 'impd',
        delayMs: 0,
      },
      [],
    ),
  ).toStrictEqual(new Set(['e2e-chaos-a', 'e2e-chaos-b']));
});

test('#findLostImps counts only stops and starts and the killed VM under a Firecracker kill', () => {
  expect(
    findLostImps(
      {
        steps: [
          { op: 'exec', name: 'e2e-chaos-a' },
          { op: 'stop-start', name: 'e2e-chaos-b' },
        ],
        fault: 'firecracker',
        delayMs: 0,
      },
      ['e2e-chaos-c'],
    ),
  ).toStrictEqual(new Set(['e2e-chaos-c', 'e2e-chaos-b']));
});

test('#parseFirecrackerVms groups the pids by the imp in their API socket', () => {
  const stdout = [
    '101 /usr/local/bin/firecracker --api-sock /var/lib/imp/imps/abc/run/api.sock',
    '102 /firecracker --id def --start-time-us 1 -- --api-sock /var/lib/imp/imps/def/run/api.sock',
    '103 /usr/local/bin/firecracker --api-sock /var/lib/imp/imps/abc/run/api.sock',
    '104 /usr/local/bin/firecracker --api-sock /var/lib/imp/templates/k/api.sock',
    '',
  ].join('\n');

  expect(parseFirecrackerVms(stdout)).toStrictEqual(
    new Map([
      ['abc', [101, 103]],
      ['def', [102]],
    ]),
  );
});
