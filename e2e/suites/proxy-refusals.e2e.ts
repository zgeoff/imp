import { expect, onTestFinished, test } from 'bun:test';
import { createServer } from 'node:net';
import { tryImp } from '../lib/imp-cli';
import { readSuitePrefix } from '../lib/suites';

// `imp proxy` refusals that boot no imp: the local ports bind before the
// command checks the imp, so a busy port fails first.

test('it refuses a busy local port before it checks the imp', async () => {
  const name = `${readSuitePrefix('proxy')}nope`;
  const busy = createServer();
  const listening = Promise.withResolvers<void>();

  busy.listen(0, '127.0.0.1', listening.resolve);

  await listening.promise;

  onTestFinished(() => {
    busy.close();
  });

  const address = busy.address();

  if (address === null || typeof address === 'string') {
    throw new Error(`the busy server has no port: ${String(address)}`);
  }

  const port = String(address.port);

  const refused = await tryImp(['proxy', name, `${port}:8080`]);

  expect(refused.exitCode).toBe(1);
  expect(refused.stdout).toBe('');

  // the port it suggests depends on the busy one
  expect(refused.stderr).toMatch(
    new RegExp(
      String.raw`^imp: local port ${port} is in use; map another one: imp proxy ${name} \d+:8080 \(0:8080 takes any free port\)\n$`,
      'v',
    ),
  );
});

test('it refuses an imp that does not exist', async () => {
  const name = `${readSuitePrefix('proxy')}nope`;

  const refused = await tryImp(['proxy', name, '0:8080']);

  expect(refused).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `imp: NOT_FOUND: imp ${name} not found\n`,
  });
});
