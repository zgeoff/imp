import { expect, onTestFinished, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
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
