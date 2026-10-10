import { expect, test } from 'bun:test';
import {
  createParkMiller,
  findLostImps,
  parseFirecrackerVms,
  pickOne,
  planChaosRound,
} from './chaos';

test('#createParkMiller gives the minimal standard sequence for seed 1', () => {
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

test('#planChaosRound plans the steps, the fault and the delay from the draws', () => {
  const draws = [0.5, 0.3, 0.1, 0.9, 0.7, 0.2, 0.4];
  const readNextDraw = () => draws.shift() ?? 0;

  expect(planChaosRound(readNextDraw, ['e2e-chaos-a', 'e2e-chaos-b'])).toStrictEqual({
    steps: [
      { op: 'wake', name: 'e2e-chaos-a' },
      { op: 'stop-start', name: 'e2e-chaos-b' },
    ],
    fault: 'impd',
    delayMs: 1200,
  });
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
