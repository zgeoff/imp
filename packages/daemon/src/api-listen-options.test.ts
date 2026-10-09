import { expect, test } from 'bun:test';
import { buildApiListenOptions } from './api-listen-options';

test('it listens on the API port with a 30 second idle timeout by default', () => {
  const options = buildApiListenOptions({ apiPort: 7070, buildContextMaxBytes: 1024 });

  expect(options).toStrictEqual({
    port: 7070,
    maxRequestBodySize: 257 * 1024 ** 2,
    idleTimeout: 30,
  });
});

test('it takes a build context larger than a move part, with a MiB of slack', () => {
  const options = buildApiListenOptions({ apiPort: 7070, buildContextMaxBytes: 1024 ** 3 });

  expect(options.maxRequestBodySize).toBe(1025 * 1024 ** 2);
});

test('it listens with the idle timeout it is given', () => {
  const options = buildApiListenOptions({ apiPort: 7070, buildContextMaxBytes: 1024 }, 1);

  expect(options.idleTimeout).toBe(1);
});
