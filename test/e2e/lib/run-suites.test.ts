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

test('#runSuites resets each suite’s prefix after the suite passes', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      return Promise.resolve(0);
    },
  });

  expect(ctx.steps).toStrictEqual(['run sleep', 'reset e2e-sleep-', 'run jail', 'reset e2e-jail-']);
});

test('#runSuites resets the suite’s prefix after each of its journeys', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['proxy'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: () => ['proxy-refusals', 'proxy-forwards'],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      return Promise.resolve(0);
    },
  });

  expect(ctx.steps).toStrictEqual([
    'run proxy-refusals',
    'reset e2e-proxy-',
    'run proxy-forwards',
    'reset e2e-proxy-',
  ]);

  expect(outcome.results).toStrictEqual([{ name: 'proxy', passed: true, ms: 0 }]);
});

test('#runSuites reboots and resets after a journey that fails, runs the next on the baseline, and fails the suite', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['proxy'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: () => ['proxy-refusals', 'proxy-forwards'],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      const exitCode = journey === 'proxy-refusals' ? 1 : 0;

      return Promise.resolve(exitCode);
    },
  });

  expect(ctx.steps).toStrictEqual([
    'run proxy-refusals',
    'reboot',
    'reset e2e-proxy-',
    'run proxy-forwards',
    'reset e2e-proxy-',
  ]);

  expect(outcome.results).toStrictEqual([{ name: 'proxy', passed: false, ms: 0 }]);
});

test('#runSuites reboots the instance before the reset after a suite that fails', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: () => Promise.resolve(1),
  });

  expect(ctx.steps).toStrictEqual(['reboot', 'reset e2e-sleep-']);
});

test('#runSuites skips the reboot and the next suite once the run is interrupted', async () => {
  const ctx = setupTest();
  let isInterrupted = false;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => isInterrupted,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      isInterrupted = true;

      return Promise.resolve(130);
    },
  });

  expect(ctx.steps).toStrictEqual(['run sleep', 'reset e2e-sleep-']);
  expect(outcome.stoppedBecause).toBe('interrupted');
});

test('#runSuites resets after the journey an interrupt stopped, runs no more of its suite, and fails it', async () => {
  const ctx = setupTest();
  let isInterrupted = false;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['proxy'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: () => ['proxy-refusals', 'proxy-forwards'],
    keep: false,
    isInterrupted: () => isInterrupted,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      isInterrupted = true;

      return Promise.resolve(0);
    },
  });

  expect(ctx.steps).toStrictEqual(['run proxy-refusals', 'reset e2e-proxy-']);

  expect(outcome).toStrictEqual({
    results: [{ name: 'proxy', passed: false, ms: 0 }],
    stoppedBecause: 'interrupted',
  });
});

test('#runSuites reports an interrupt that comes after the last suite', async () => {
  const ctx = setupTest();
  let isInterrupted = false;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => isInterrupted,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: () => Promise.resolve(0),
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

test('#runSuites neither makes the instance anew nor runs on when a reset fails after an interrupt', async () => {
  const ctx = setupTest();
  let isInterrupted = false;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => isInterrupted,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      isInterrupted = true;

      return Promise.resolve(130);
    },
    reset: () => Promise.reject(new Error('impd is down')),
  });

  expect(ctx.steps).toStrictEqual([
    'run sleep',
    'log the sleep journey left the baseline dirty: impd is down',
  ]);

  expect(outcome).toStrictEqual({
    results: [{ name: 'sleep', passed: false, ms: 0 }],
    stoppedBecause: 'interrupted',
  });
});

test('#runSuites leaves scale’s imps for restart, whose reset takes them', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['scale', 'restart', 'tailscale'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: () => Promise.resolve(0),
  });

  expect(ctx.steps).toStrictEqual(['reset e2e-restart-,e2e-scale-', 'reset e2e-tailscale-']);
});

test('#runSuites neither reboots nor resets after scale fails when restart runs next', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['scale', 'restart'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      const exitCode = journey === 'scale' ? 1 : 0;

      return Promise.resolve(exitCode);
    },
  });

  expect(ctx.steps).toStrictEqual(['run scale', 'run restart', 'reset e2e-restart-,e2e-scale-']);
  expect(outcome.results.map((result) => result.passed)).toStrictEqual([false, true]);
});

test('#runSuites resets scale after it when restart is not in the run', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['scale'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: () => Promise.resolve(0),
  });

  expect(ctx.steps).toStrictEqual(['reset e2e-scale-']);
});

test('#runSuites leaves what each journey left with --keep', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: true,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: () => Promise.resolve(1),
  });

  expect(ctx.steps).toBeEmpty();
});

test('#runSuites makes the instance anew and runs on when the reset fails', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

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
    'log the sleep journey left the baseline dirty: CONFLICT',
    'recreate',
    'run jail',
    'reset e2e-jail-',
  ]);

  expect(outcome.results.map((result) => result.passed)).toStrictEqual([false, true]);
});

test('#runSuites makes the instance anew before the next journey of a suite when a reset fails', async () => {
  const ctx = setupTest();
  let resets = 0;

  await runSuites({
    ...ctx.recorders,
    names: ['proxy'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: () => ['proxy-refusals', 'proxy-forwards'],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      return Promise.resolve(0);
    },
    reset: (prefixes) => {
      ctx.steps.push(`reset ${prefixes.join(',')}`);

      resets += 1;

      return resets === 1 ? Promise.reject(new Error('CONFLICT')) : Promise.resolve();
    },
  });

  expect(ctx.steps).toStrictEqual([
    'run proxy-refusals',
    'reset e2e-proxy-',
    'log the proxy-refusals journey left the baseline dirty: CONFLICT',
    'recreate',
    'run proxy-forwards',
    'reset e2e-proxy-',
  ]);
});

test('#runSuites stops before the next journey of a suite when the instance cannot be made anew', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['proxy', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => (name === 'proxy' ? ['proxy-refusals', 'proxy-forwards'] : [name]),
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      return Promise.resolve(0);
    },
    reset: () => Promise.reject(new Error('impd is down')),
    recreate: () => Promise.reject(new Error('dev.sh up exited 1')),
  });

  expect(ctx.steps).toStrictEqual([
    'run proxy-refusals',
    'log the proxy-refusals journey left the baseline dirty: impd is down',
  ]);

  expect(outcome).toStrictEqual({
    results: [{ name: 'proxy', passed: false, ms: 0 }],
    stoppedBecause: 'the instance could not be made anew after proxy-refusals: dev.sh up exited 1',
  });
});

test('#runSuites runs every journey of a suite and resets after none with --keep', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['proxy'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: () => ['proxy-refusals', 'proxy-forwards'],
    keep: true,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      const exitCode = journey === 'proxy-refusals' ? 1 : 0;

      return Promise.resolve(exitCode);
    },
  });

  expect(ctx.steps).toStrictEqual(['run proxy-refusals', 'run proxy-forwards']);
  expect(outcome.results).toStrictEqual([{ name: 'proxy', passed: false, ms: 0 }]);
});

test('#runSuites makes the instance anew when the reboot after a failure throws', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: () => Promise.resolve(1),
    reboot: () => Promise.reject(new Error('dev.sh reboot exited 1')),
  });

  expect(ctx.steps).toStrictEqual([
    'log the sleep journey left the baseline dirty: dev.sh reboot exited 1',
    'recreate',
  ]);
});

test('#runSuites stops the run when the instance cannot be made anew', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      return Promise.resolve(0);
    },
    reset: () => Promise.reject(new Error('impd is down')),
    recreate: () => Promise.reject(new Error('dev.sh up exited 1')),
  });

  expect(ctx.steps).toStrictEqual([
    'run sleep',
    'log the sleep journey left the baseline dirty: impd is down',
  ]);

  expect(outcome.stoppedBecause).toBe(
    'the instance could not be made anew after sleep: dev.sh up exited 1',
  );
});

test('#runSuites fails a suite that throws, restores the baseline, and runs on', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['sleep', 'jail'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: (journey) => {
      ctx.steps.push(`run ${journey}`);

      return journey === 'sleep' ? Promise.reject(new Error('spawn ENOENT')) : Promise.resolve(0);
    },
  });

  expect(ctx.steps).toStrictEqual([
    'run sleep',
    'log the sleep journey could not run: spawn ENOENT',
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

test('#runSuites fails a suite whose checks throw, and runs on', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['chaos', 'sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    runJourney: () => Promise.resolve(0),
    checkJourney: (suite) =>
      suite === 'chaos' ? Promise.reject(new Error('no impd log')) : Promise.resolve(true),
  });

  expect(outcome.results.map((result) => result.passed)).toStrictEqual([false, true]);
});

test('#runSuites fails a suite whose checks fail', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['chaos'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    runJourney: () => Promise.resolve(0),
    checkJourney: () => Promise.resolve(false),
  });

  expect(outcome.results).toStrictEqual([{ name: 'chaos', passed: false, ms: 0 }]);
});

test('#runSuites checks each journey under its suite’s name', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['proxy'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: () => ['proxy-refusals', 'proxy-forwards'],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    runJourney: () => Promise.resolve(0),
    checkJourney: (suite, journey) => {
      ctx.steps.push(`check ${suite} ${journey}`);

      return Promise.resolve(true);
    },
  });

  expect(ctx.steps).toStrictEqual([
    'check proxy proxy-refusals',
    'reset e2e-proxy-',
    'check proxy proxy-forwards',
    'reset e2e-proxy-',
  ]);
});

test('#runSuites times each suite from its start to the end of its last reset', async () => {
  const ctx = setupTest();
  let clock = 1000;

  const outcome = await runSuites({
    ...ctx.recorders,
    names: ['proxy'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: () => ['proxy-refusals', 'proxy-forwards'],
    keep: false,
    isInterrupted: () => false,
    now: () => clock,
    checkJourney: () => Promise.resolve(true),
    runJourney: () => {
      clock += 250;

      return Promise.resolve(0);
    },
    reset: () => {
      clock += 10;

      return Promise.resolve();
    },
  });

  expect(outcome.results).toStrictEqual([{ name: 'proxy', passed: true, ms: 520 }]);
});

test('#runSuites reports each suite as it starts and ends', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.recorders,
    names: ['sleep'],
    prefixOf: (name) => `e2e-${name}-`,
    journeysOf: (name) => [name],
    keep: false,
    isInterrupted: () => false,
    now: () => 0,
    checkJourney: () => Promise.resolve(true),
    runJourney: () => Promise.resolve(0),
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
