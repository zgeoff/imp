import { expect, test } from 'bun:test';
import { checkRunPassed, runSuites } from './run-suites';

// one recorder for every step, so a test reads their order; what each
// scenario depends on is passed in its own test
function setupTest() {
  const steps: string[] = [];

  return {
    steps,
    recorders: {
      reset: (prefixes: readonly string[]) => {
        steps.push(`reset ${prefixes.join(',')}`);

        return Promise.resolve();
      },
      reboot: () => {
        steps.push('reboot');

        return Promise.resolve();
      },
      recreate: () => {
        steps.push('recreate');

        return Promise.resolve();
      },
      onSuiteStart: () => {},
      onSuiteEnd: () => {},
      log: (line: string) => {
        steps.push(`log ${line.trim()}`);
      },
    },
  };
}

test('it resets each suite’s prefix after the suite passes', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      return Promise.resolve(0);
    },
  });

  expect(ctx.steps).toStrictEqual(['run sleep', 'reset e2e-sleep-', 'run jail', 'reset e2e-jail-']);
});

test('it reboots the instance before the reset after a suite that fails', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: () => Promise.resolve(1),
  });

  expect(ctx.steps).toStrictEqual(['reboot', 'reset e2e-sleep-']);
});

test('it skips the reboot and the next suite once the run is interrupted', async () => {
  const ctx = setupTest();
  let isInterrupted = false;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => isInterrupted,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      isInterrupted = true;

      return Promise.resolve(130);
    },
  });

  expect(ctx.steps).toStrictEqual(['run sleep', 'reset e2e-sleep-']);
  expect(outcome.stoppedBecause).toBe('interrupted');
});

test('it reports an interrupt that comes after the last suite', async () => {
  const ctx = setupTest();
  let isInterrupted = false;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => isInterrupted,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: () => Promise.resolve(0),
    reset: () => {
      isInterrupted = true;

      return Promise.resolve();
    },
  });

  expect(outcome).toStrictEqual({
    results: [{ name: 'sleep', passed: true, ms: 0 }],
    stoppedBecause: 'interrupted',
  });
});

test('it neither makes the instance anew nor runs on when a reset fails after an interrupt', async () => {
  const ctx = setupTest();
  let isInterrupted = false;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => isInterrupted,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      isInterrupted = true;

      return Promise.resolve(130);
    },
    reset: () => Promise.reject(new Error('impd is down')),
  });

  expect(ctx.steps).toStrictEqual([
    'run sleep',
    'log the sleep suite left the baseline dirty: impd is down',
  ]);

  expect(outcome).toStrictEqual({
    results: [{ name: 'sleep', passed: false, ms: 0 }],
    stoppedBecause: 'interrupted',
  });
});

test('it leaves scale’s imps for restart, whose reset takes them', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['scale', 'restart', 'tailscale'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: () => Promise.resolve(0),
  });

  expect(ctx.steps).toStrictEqual(['reset e2e-restart-,e2e-scale-', 'reset e2e-tailscale-']);
});

test('it neither reboots nor resets after scale fails when restart runs next', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['scale', 'restart'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      const exitCode = name === 'scale' ? 1 : 0;

      return Promise.resolve(exitCode);
    },
  });

  expect(ctx.steps).toStrictEqual(['run scale', 'run restart', 'reset e2e-restart-,e2e-scale-']);
  expect(outcome.results.map((result) => result.passed)).toStrictEqual([false, true]);
});

test('it resets scale after it when restart is not in the run', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['scale'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: () => Promise.resolve(0),
  });

  expect(ctx.steps).toStrictEqual(['reset e2e-scale-']);
});

test('it leaves what each suite made with --keep', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: true,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: () => Promise.resolve(1),
  });

  expect(ctx.steps).toBeEmpty();
});

test('it makes the instance anew and runs on when the reset fails', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      return Promise.resolve(0);
    },
    reset: (prefixes) => {
      ctx.steps.push(`reset ${prefixes.join(',')}`);

      return prefixes.includes('e2e-sleep-')
        ? Promise.reject(new Error('CONFLICT'))
        : Promise.resolve();
    },
  });

  expect(ctx.steps).toStrictEqual([
    'run sleep',
    'reset e2e-sleep-',
    'log the sleep suite left the baseline dirty: CONFLICT',
    'recreate',
    'run jail',
    'reset e2e-jail-',
  ]);

  expect(outcome.results.map((result) => result.passed)).toStrictEqual([false, true]);
});

test('it makes the instance anew when the reboot after a failure throws', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: () => Promise.resolve(1),
    reboot: () => Promise.reject(new Error('dev.sh reboot exited 1')),
  });

  expect(ctx.steps).toStrictEqual([
    'log the sleep suite left the baseline dirty: dev.sh reboot exited 1',
    'recreate',
  ]);
});

test('it stops the run when the instance cannot be made anew', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      return Promise.resolve(0);
    },
    reset: () => Promise.reject(new Error('impd is down')),
    recreate: () => Promise.reject(new Error('dev.sh up exited 1')),
  });

  expect(ctx.steps).toStrictEqual([
    'run sleep',
    'log the sleep suite left the baseline dirty: impd is down',
  ]);

  expect(outcome.stoppedBecause).toBe(
    'the instance could not be made anew after sleep: dev.sh up exited 1',
  );
});

test('it fails a suite that throws, restores the baseline, and runs on', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      return name === 'sleep' ? Promise.reject(new Error('spawn ENOENT')) : Promise.resolve(0);
    },
  });

  expect(ctx.steps).toStrictEqual([
    'run sleep',
    'log the sleep suite could not run: spawn ENOENT',
    'reboot',
    'reset e2e-sleep-',
    'run jail',
    'reset e2e-jail-',
  ]);

  expect(outcome).toStrictEqual({
    results: [
      { name: 'sleep', passed: false, ms: 0 },
      { name: 'jail', passed: true, ms: 0 },
    ],
    stoppedBecause: null,
  });
});

test('it fails a suite whose checks throw, and runs on', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['chaos', 'sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    runSuite: () => Promise.resolve(0),
    checkSuite: (name) =>
      name === 'chaos' ? Promise.reject(new Error('no impd log')) : Promise.resolve(true),
  });

  expect(outcome.results.map((result) => result.passed)).toStrictEqual([false, true]);
});

test('it fails a suite whose checks fail', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['chaos'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    runSuite: () => Promise.resolve(0),
    checkSuite: () => Promise.resolve(false),
  });

  expect(outcome.results).toStrictEqual([{ name: 'chaos', passed: false, ms: 0 }]);
});

test('it times each suite from its start to the end of its reset', async () => {
  const ctx = setupTest();
  let clock = 1000;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => clock,
    checkSuite: () => Promise.resolve(true),
    runSuite: () => {
      clock += 250;

      return Promise.resolve(0);
    },
  });

  expect(outcome.results).toStrictEqual([{ name: 'sleep', passed: true, ms: 250 }]);
});

test('it reports each suite as it starts and ends', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkSuite: () => Promise.resolve(true),
    runSuite: () => Promise.resolve(0),
    onSuiteStart: (name) => {
      ctx.steps.push(`start ${name}`);
    },
    onSuiteEnd: (result) => {
      ctx.steps.push(`end ${result.name} ${String(result.passed)}`);
    },
  });

  expect(ctx.steps).toStrictEqual(['start sleep', 'reset e2e-sleep-', 'end sleep true']);
});

test.each([
  ['every section passed', [true, true], null, false, true],
  ['a section failed', [true, false], null, false, false],
  [
    'the run stopped',
    [true],
    'the instance could not be made anew after sleep: down',
    false,
    false,
  ],
  ['a signal came after every section passed', [true, true], null, true, false],
])('#checkRunPassed: %s', (_, passed, stoppedBecause, interrupted, expected) => {
  expect(checkRunPassed({ passed, stoppedBecause, interrupted })).toBe(expected);
});
