import { expect, test } from 'bun:test';
import { runConntrackFlush, runForwardRulesList, runPairFlush } from './egress-commands';

test('#runForwardRulesList reads the FORWARD chain from iptables -S', async () => {
  const runs: (readonly string[])[] = [];

  const rules = await runForwardRulesList((argv) => {
    runs.push(argv);

    return Promise.resolve({ exitCode: 0, stdout: '-P FORWARD ACCEPT\n', stderr: '' });
  });

  expect({ rules, runs }).toStrictEqual({
    rules: '-P FORWARD ACCEPT\n',
    runs: [['iptables', '-S', 'FORWARD']],
  });
});

test('#runForwardRulesList rejects with the exit code and what iptables said', () => {
  const rules = runForwardRulesList(() =>
    Promise.resolve({ exitCode: 4, stdout: '', stderr: 'iptables: Permission denied.\n' }),
  );

  expect(rules).rejects.toThrow(
    new Error('iptables -S FORWARD exited 4: iptables: Permission denied.'),
  );
});

test('#runPairFlush deletes the flows of a pair in both directions', async () => {
  const runs: (readonly string[])[] = [];

  await runPairFlush('10.66.0.2', '10.66.0.6', (argv) => {
    runs.push(argv);

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });

  expect(runs).toStrictEqual([
    ['conntrack', '-D', '-s', '10.66.0.2', '-d', '10.66.0.6'],
    ['conntrack', '-D', '-s', '10.66.0.6', '-d', '10.66.0.2'],
  ]);
});

test('#runPairFlush takes a direction with no flows as done', async () => {
  const runs: (readonly string[])[] = [];

  await runPairFlush('10.66.0.2', '10.66.0.6', (argv) => {
    runs.push(argv);

    return Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: 'conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.\n',
    });
  });

  expect(runs).toHaveLength(2);
});

test('#runPairFlush rejects with the direction that failed', () => {
  const flush = runPairFlush('10.66.0.2', '10.66.0.6', () =>
    Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Operation not permitted\n' }),
  );

  expect(flush).rejects.toThrow(
    new Error('conntrack -D -s 10.66.0.2 -d 10.66.0.6 exited 1: Operation not permitted'),
  );
});

test('#runConntrackFlush deletes the flows from the guest', async () => {
  const runs: (readonly string[])[] = [];

  await runConntrackFlush('10.66.0.2', (argv) => {
    runs.push(argv);

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });

  expect(runs).toStrictEqual([['conntrack', '-D', '-s', '10.66.0.2']]);
});

test('#runConntrackFlush takes a guest with no flows as done', () => {
  const flush = runConntrackFlush('10.66.0.2', () =>
    Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: 'conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.\n',
    }),
  );

  expect(flush).resolves.toBeUndefined();
});

test('#runConntrackFlush rejects with the exit code and what conntrack said', () => {
  const flush = runConntrackFlush('10.66.0.2', () =>
    Promise.resolve({ exitCode: 2, stdout: '', stderr: 'conntrack: command not found\n' }),
  );

  expect(flush).rejects.toThrow(
    new Error('conntrack -D -s 10.66.0.2 exited 2: conntrack: command not found'),
  );
});
