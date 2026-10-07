import { expect, test } from 'bun:test';
import {
  ServiceDefSchema,
  ServiceListSchema,
  ServiceLogSchema,
  ServiceNameSchema,
  ServiceRestartSchema,
  ServiceSchema,
  ServiceStateSchema,
} from './service-schema';

test.each(['web', '0web', 'my-service-2', `a${'b'.repeat(62)}`])(
  '#ServiceNameSchema accepts the name %s',
  (name) => {
    expect(ServiceNameSchema.safeParse(name).data).toBe(name);
  },
);

test.each(['', '-web', 'Web', 'my_service', 'web.service', `a${'b'.repeat(63)}`])(
  '#ServiceNameSchema rejects the name %p',
  (name) => {
    const result = ServiceNameSchema.safeParse(name);

    expect(result.error?.issues).toPartiallyContain(
      expect.objectContaining({
        path: [],
        message:
          'must be a lowercase letter or digit followed by up to 62 lowercase letters, digits or -',
      }),
    );
  },
);

test.each(['always', 'on-failure', 'never'])('#ServiceRestartSchema accepts %s', (restart) => {
  expect(ServiceRestartSchema.safeParse(restart).data).toBe(restart);
});

test('#ServiceRestartSchema rejects a policy outside the list', () => {
  const result = ServiceRestartSchema.safeParse('sometimes');

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test.each(['starting', 'running', 'backoff', 'stopped', 'exited'])(
  '#ServiceStateSchema accepts %s',
  (state) => {
    expect(ServiceStateSchema.safeParse(state).data).toBe(state);
  },
);

test('#ServiceStateSchema rejects a state outside the list', () => {
  const result = ServiceStateSchema.safeParse('paused');

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test('#ServiceDefSchema accepts a full service file', () => {
  const payload = {
    name: 'web',
    argv: ['node', 'server.js'],
    env: ['PORT=8080'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'on-failure',
  } as const;

  const result = ServiceDefSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ServiceDefSchema accepts a service file with only a name and argv', () => {
  const payload = { name: 'web', argv: ['node', 'server.js'] } as const;
  const result = ServiceDefSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ServiceDefSchema rejects a name that is not a service name', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'Web',
    argv: ['node', 'server.js'],
    env: ['PORT=8080'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'on-failure',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['name'] }));
});

test('#ServiceDefSchema rejects an empty argv', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'web',
    argv: [],
    env: ['PORT=8080'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'on-failure',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['argv'] }));
});

test('#ServiceDefSchema rejects an argv of more than 256 words', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'web',
    argv: Array.from({ length: 257 }, () => 'x'),
    env: ['PORT=8080'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'on-failure',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['argv'] }));
});

test('#ServiceDefSchema rejects an empty word in argv', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'web',
    argv: ['node', ''],
    env: ['PORT=8080'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'on-failure',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['argv', 1] }));
});

test('#ServiceDefSchema rejects an env entry that is not KEY=VALUE', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'web',
    argv: ['node', 'server.js'],
    env: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'on-failure',
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['env', 0], message: 'must be KEY=VALUE' }),
  );
});

test('#ServiceDefSchema rejects more than 256 env entries', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'web',
    argv: ['node', 'server.js'],
    env: Array.from({ length: 257 }, () => 'PORT=8080'),
    cwd: '/srv/web',
    user: 'app',
    restart: 'on-failure',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['env'] }));
});

test('#ServiceDefSchema rejects an empty cwd', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'web',
    argv: ['node', 'server.js'],
    env: ['PORT=8080'],
    cwd: '',
    user: 'app',
    restart: 'on-failure',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['cwd'] }));
});

test('#ServiceDefSchema rejects an empty user', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'web',
    argv: ['node', 'server.js'],
    env: ['PORT=8080'],
    cwd: '/srv/web',
    user: '',
    restart: 'on-failure',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['user'] }));
});

test('#ServiceDefSchema rejects a restart policy outside the list', () => {
  const result = ServiceDefSchema.safeParse({
    name: 'web',
    argv: ['node', 'server.js'],
    env: ['PORT=8080'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'sometimes',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['restart'] }));
});

test('#ServiceSchema accepts a running service', () => {
  const payload = {
    name: 'web',
    state: 'running',
    pid: 42,
    restarts: 0,
    lastExit: { code: 1, signal: null },
    argv: ['node', 'server.js'],
    envKeys: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'always',
    source: 'api',
    root: false,
  } as const;

  const result = ServiceSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ServiceSchema accepts a stopped service with no pid, exit, cwd or user', () => {
  const payload = {
    name: 'web',
    state: 'stopped',
    pid: null,
    restarts: 3,
    lastExit: null,
    argv: ['node', 'server.js'],
    envKeys: [],
    cwd: null,
    user: null,
    restart: 'never',
    source: 'image',
    root: true,
  } as const;

  const result = ServiceSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ServiceSchema rejects a state outside the list', () => {
  const result = ServiceSchema.safeParse({
    name: 'web',
    state: 'paused',
    pid: 42,
    restarts: 0,
    lastExit: { code: 1, signal: null },
    argv: ['node', 'server.js'],
    envKeys: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'always',
    source: 'api',
    root: false,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['state'] }));
});

test('#ServiceSchema rejects a pid of zero', () => {
  const result = ServiceSchema.safeParse({
    name: 'web',
    state: 'running',
    pid: 0,
    restarts: 0,
    lastExit: { code: 1, signal: null },
    argv: ['node', 'server.js'],
    envKeys: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'always',
    source: 'api',
    root: false,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['pid'] }));
});

test('#ServiceSchema rejects a fractional pid', () => {
  const result = ServiceSchema.safeParse({
    name: 'web',
    state: 'running',
    pid: 4.2,
    restarts: 0,
    lastExit: { code: 1, signal: null },
    argv: ['node', 'server.js'],
    envKeys: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'always',
    source: 'api',
    root: false,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['pid'] }));
});

test('#ServiceSchema rejects a negative restart count', () => {
  const result = ServiceSchema.safeParse({
    name: 'web',
    state: 'running',
    pid: 42,
    restarts: -1,
    lastExit: { code: 1, signal: null },
    argv: ['node', 'server.js'],
    envKeys: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'always',
    source: 'api',
    root: false,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['restarts'] }));
});

test('#ServiceSchema rejects a fractional exit code', () => {
  const result = ServiceSchema.safeParse({
    name: 'web',
    state: 'running',
    pid: 42,
    restarts: 0,
    lastExit: { code: 1.5, signal: null },
    argv: ['node', 'server.js'],
    envKeys: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'always',
    source: 'api',
    root: false,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['lastExit', 'code'] }),
  );
});

test('#ServiceSchema rejects a restart policy outside the list', () => {
  const result = ServiceSchema.safeParse({
    name: 'web',
    state: 'running',
    pid: 42,
    restarts: 0,
    lastExit: { code: 1, signal: null },
    argv: ['node', 'server.js'],
    envKeys: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'sometimes',
    source: 'api',
    root: false,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['restart'] }));
});

test('#ServiceSchema rejects a source outside the list', () => {
  const result = ServiceSchema.safeParse({
    name: 'web',
    state: 'running',
    pid: 42,
    restarts: 0,
    lastExit: { code: 1, signal: null },
    argv: ['node', 'server.js'],
    envKeys: ['PORT'],
    cwd: '/srv/web',
    user: 'app',
    restart: 'always',
    source: 'manual',
    root: false,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['source'] }));
});

test('#ServiceListSchema accepts a recorded list of services', () => {
  const payload = {
    services: [
      {
        name: 'web',
        state: 'running',
        pid: 42,
        restarts: 0,
        lastExit: null,
        argv: ['node', 'server.js'],
        envKeys: ['PORT'],
        cwd: null,
        user: null,
        restart: 'always',
        source: 'api',
        root: false,
      },
    ],
    recorded: true,
  } as const;

  const result = ServiceListSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ServiceListSchema rejects a service that breaks the service schema', () => {
  const result = ServiceListSchema.safeParse({
    services: [
      {
        name: 'web',
        state: 'paused',
        pid: 42,
        restarts: 0,
        lastExit: null,
        argv: ['node', 'server.js'],
        envKeys: ['PORT'],
        cwd: null,
        user: null,
        restart: 'always',
        source: 'api',
        root: false,
      },
    ],
    recorded: true,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['services', 0, 'state'] }),
  );
});

test('#ServiceLogSchema accepts a piece of a log', () => {
  const payload = { type: 'log', service: 'web', text: 'listening on 8080\n' } as const;
  const result = ServiceLogSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ServiceLogSchema accepts a sleeping event with the imp state', () => {
  const payload = { type: 'sleeping', state: 'sleeping' } as const;
  const result = ServiceLogSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test.each(['awake', 'restarting'])('#ServiceLogSchema accepts a bare %s event', (type) => {
  expect(ServiceLogSchema.safeParse({ type }).data).toStrictEqual({ type });
});

test('#ServiceLogSchema rejects a sleeping event with a state outside the imp states', () => {
  const result = ServiceLogSchema.safeParse({ type: 'sleeping', state: 'napping' });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['state'] }));
});

test('#ServiceLogSchema rejects an unknown event type', () => {
  const result = ServiceLogSchema.safeParse({ type: 'paused' });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['type'] }));
});
