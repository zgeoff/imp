import { expect, test } from 'bun:test';
import { runSuites } from './run-suites';

// one recorder for every step, so a test reads their order
function setupTest() {
  const steps: string[] = [];

  return {
    steps,
    deps: {
      prefixOf: (name: string) => `e2e-${name}-`,
      keep: false,
      checkSuite: () => Promise.resolve(true),
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
      isInterrupted: () => false,
      now: () => 0,
      onSuiteStart: () => {},
      onSuiteEnd: () => {},
      log: () => {},
    },
  };
}

test('it resets each suite’s prefix after the suite passes', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.deps,
    names: ['sleep', 'jail'],
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
    ...ctx.deps,
    names: ['sleep'],
    runSuite: () => Promise.resolve(1),
  });

  expect(ctx.steps).toStrictEqual(['reboot', 'reset e2e-sleep-']);
});

test('it skips the reboot and the next suite once the run is interrupted', async () => {
  const ctx = setupTest();
  let isInterrupted = false;

  const outcome = await runSuites({
    ...ctx.deps,
    names: ['sleep', 'jail'],
    isInterrupted: () => isInterrupted,
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      isInterrupted = true;

      return Promise.resolve(130);
    },
  });

  expect(ctx.steps).toStrictEqual(['run sleep', 'reset e2e-sleep-']);
  expect(outcome.stoppedBecause).toBe('interrupted');
});

test('it leaves scale’s imps for restart, whose reset takes them', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.deps,
    names: ['scale', 'restart', 'tailscale'],
    runSuite: () => Promise.resolve(0),
  });

  expect(ctx.steps).toStrictEqual(['reset e2e-restart-,e2e-scale-', 'reset e2e-tailscale-']);
});

test('it resets scale after it when restart is not in the run', async () => {
  const ctx = setupTest();

  await runSuites({ ...ctx.deps, names: ['scale'], runSuite: () => Promise.resolve(0) });

  expect(ctx.steps).toStrictEqual(['reset e2e-scale-']);
});

test('it leaves what each suite made with --keep', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.deps,
    keep: true,
    names: ['sleep'],
    runSuite: () => Promise.resolve(1),
  });

  expect(ctx.steps).toBeEmpty();
});

test('it makes the instance anew and runs on when the reset fails', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.deps,
    names: ['sleep', 'jail'],
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
    'recreate',
    'run jail',
    'reset e2e-jail-',
  ]);

  expect(outcome.results.map((result) => result.passed)).toStrictEqual([false, true]);
});

test('it makes the instance anew when the reboot after a failure throws', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.deps,
    names: ['sleep'],
    runSuite: () => Promise.resolve(1),
    reboot: () => Promise.reject(new Error('dev.sh reboot exited 1')),
  });

  expect(ctx.steps).toStrictEqual(['recreate']);
});

test('it stops the run when the instance cannot be made anew', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.deps,
    names: ['sleep', 'jail'],
    runSuite: (name) => {
      ctx.steps.push(`run ${name}`);

      return Promise.resolve(0);
    },
    reset: () => Promise.reject(new Error('impd is down')),
    recreate: () => Promise.reject(new Error('dev.sh up exited 1')),
  });

  expect(ctx.steps).toStrictEqual(['run sleep']);

  expect(outcome.stoppedBecause).toBe(
    'the instance could not be made anew after sleep: dev.sh up exited 1',
  );
});

test('it fails a suite whose checks fail', async () => {
  const ctx = setupTest();

  const outcome = await runSuites({
    ...ctx.deps,
    names: ['chaos'],
    runSuite: () => Promise.resolve(0),
    checkSuite: () => Promise.resolve(false),
  });

  expect(outcome.results).toStrictEqual([{ name: 'chaos', passed: false, ms: 0 }]);
});

test('it reports each suite as it starts and ends', async () => {
  const ctx = setupTest();

  await runSuites({
    ...ctx.deps,
    names: ['sleep'],
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
