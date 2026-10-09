import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { findFreePorts } from './find-free-ports';

test('it hands out distinct ports', () => {
  const free = findFreePorts(5);
  const ports = [free.take(), free.take(), free.take(), free.take(), free.take()];

  expect(new Set(ports).size).toBe(5);
});

test('it picks ports from the 4000 just below the start of the ephemeral range', async () => {
  const range = await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8');

  const ephemeralStart = Number(range.trim().split(/\s+/)[0]);
  const free = findFreePorts(3);
  const ports = [free.take(), free.take(), free.take()];

  expect(ports).toSatisfyAll(
    (port: number) => port >= ephemeralStart - 4000 && port < ephemeralStart,
  );
});

test('it leaves the ports free for the test to bind', () => {
  const free = findFreePorts(2);
  const first = free.take();
  const second = free.take();

  const firstListener = Bun.listen({
    hostname: '127.0.0.1',
    port: first,
    socket: { data: () => {} },
  });

  onTestFinished(() => {
    firstListener.stop(true);
  });

  const secondListener = Bun.listen({
    hostname: '127.0.0.1',
    port: second,
    socket: { data: () => {} },
  });

  onTestFinished(() => {
    secondListener.stop(true);
  });

  expect([firstListener.port, secondListener.port]).toStrictEqual([first, second]);
});

test('it throws when more ports are taken than were asked for', () => {
  const free = findFreePorts(2);

  free.take();
  free.take();

  expect(() => free.take()).toThrowWithMessage(Error, /^only 2 free ports were asked for$/);
});

test('it skips a port that a TCP listener holds', () => {
  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });

  onTestFinished(() => {
    held.stop(true);
  });

  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const next = probe.port;

  probe.stop(true);

  const picks = [held.port, next];

  const free = findFreePorts(1, {
    pick: () => {
      const port = picks.shift();

      invariant(port, 'the picks ran out');

      return port;
    },
  });

  expect(free.take()).toBe(next);
});

test('it skips a port that a UDP socket holds', async () => {
  const held = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0 });

  onTestFinished(() => {
    held.close();
  });

  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const next = probe.port;

  probe.stop(true);

  const picks = [held.port, next];

  const free = findFreePorts(1, {
    pick: () => {
      const port = picks.shift();

      invariant(port, 'the picks ran out');

      return port;
    },
  });

  expect(free.take()).toBe(next);
});

test('it skips a port that an earlier picker in this process claimed', () => {
  const probes = [0, 0].map(() =>
    Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } }),
  );

  const [claimed, next] = probes.map((probe) => probe.port);

  for (const probe of probes) {
    probe.stop(true);
  }

  invariant(claimed);
  invariant(next);

  const earlierPicks = [claimed];

  findFreePorts(1, {
    pick: () => {
      const port = earlierPicks.shift();

      invariant(port, 'the earlier picks ran out');

      return port;
    },
  });

  const picks = [claimed, next];

  const free = findFreePorts(1, {
    pick: () => {
      const port = picks.shift();

      invariant(port, 'the picks ran out');

      return port;
    },
  });

  expect(free.take()).toBe(next);
});

test('it releases its claim on each port when the test ends', () => {
  const port = findFreePorts(1).take();

  onTestFinished(() => {
    const claim = Bun.listen({
      unix: `\0imp-test-port-${String(port)}`,
      socket: { data: () => {} },
    });

    claim.stop(true);
  });

  expect(() =>
    Bun.listen({ unix: `\0imp-test-port-${String(port)}`, socket: { data: () => {} } }),
  ).toThrow();
});

test('it never hands two pickers in separate processes the same port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'find-free-ports-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // ports the kernel found free, which no picker has claimed; both pickers try them in this order
  const probes = [0, 0, 0, 0].map(() =>
    Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } }),
  );

  const sequence = probes.map((probe) => probe.port);

  for (const probe of probes) {
    probe.stop(true);
  }

  await writeFile(
    join(dir, 'picker.test.ts'),
    `import { test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { waitFor } from ${JSON.stringify(Bun.resolveSync('@imp/test-utils/wait-for', import.meta.dir))};
import { findFreePorts } from ${JSON.stringify(join(import.meta.dir, 'find-free-ports.ts'))};

test('it picks two ports and holds them until released', async () => {
  const picks = ${JSON.stringify(sequence)};
  const free = findFreePorts(2, {
    pick: () => {
      const port = picks.shift();

      if (port === undefined) {
        throw new Error('the picks ran out');
      }

      return port;
    },
  });

  writeFileSync(process.env.PICKED_FILE ?? '', JSON.stringify([free.take(), free.take()]));
  await waitFor(() => {
    if (!existsSync('release')) {
      throw new Error('not released yet');
    }
  });
});
`,
  );

  const first = Bun.spawn([process.execPath, 'test', './picker.test.ts'], {
    cwd: dir,
    env: { ...process.env, TMPDIR: dir, PICKED_FILE: join(dir, 'first.json') },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  onTestFinished(() => {
    first.kill();
  });

  const firstPorts = await waitFor(async (): Promise<unknown> => {
    const picked = await readFile(join(dir, 'first.json'), 'utf8');

    return JSON.parse(picked) as unknown;
  });

  const second = Bun.spawn([process.execPath, 'test', './picker.test.ts'], {
    cwd: dir,
    env: { ...process.env, TMPDIR: dir, PICKED_FILE: join(dir, 'second.json') },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  onTestFinished(() => {
    second.kill();
  });

  const secondPorts = await waitFor(async (): Promise<unknown> => {
    const picked = await readFile(join(dir, 'second.json'), 'utf8');

    return JSON.parse(picked) as unknown;
  });

  await writeFile(join(dir, 'release'), '');

  const firstExit = await first.exited;
  const secondExit = await second.exited;

  expect(firstPorts).toStrictEqual([sequence[0], sequence[1]]);
  expect(secondPorts).toStrictEqual([sequence[2], sequence[3]]);
  expect(firstExit).toBe(0);
  expect(secondExit).toBe(0);
});
