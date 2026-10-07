import { expect, test } from 'bun:test';
import {
  BasicUserSchema,
  ExposeInputSchema,
  ExposeResultSchema,
  ExposureSchema,
  PublicAuthSchema,
} from './exposure-schema';

test.each(['tailnet', 'public'])('#ExposureSchema accepts the %s exposure', (input) => {
  expect(ExposureSchema.safeParse(input).data).toBe(input);
});

test.each(['private'])('#ExposureSchema rejects the unknown exposure %s', (input) => {
  const result = ExposureSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test.each(['none', 'token', 'basic'])('#PublicAuthSchema accepts the %s auth', (input) => {
  expect(PublicAuthSchema.safeParse(input).data).toBe(input);
});

test.each(['password'])('#PublicAuthSchema rejects the unknown auth %s', (input) => {
  const result = PublicAuthSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test.each(['imp', 'a!~', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'])(
  '#BasicUserSchema accepts the user name %s',
  (input) => {
    expect(BasicUserSchema.safeParse(input).data).toBe(input);
  },
);

test.each(['', 'a:b', 'a b', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'])(
  '#BasicUserSchema rejects the user name %s',
  (input) => {
    const result = BasicUserSchema.safeParse(input);

    expect(result.error?.issues).toPartiallyContain(
      expect.objectContaining({
        path: [],
        message: 'must be 1 to 64 printable characters, without a colon',
      }),
    );
  },
);

test('#ExposeInputSchema defaults the auth to a token', () => {
  expect(ExposeInputSchema.safeParse({ name: 'dev' }).data).toStrictEqual({
    name: 'dev',
    auth: 'token',
  });
});

test('#ExposeInputSchema accepts a user with basic auth', () => {
  const payload = { name: 'dev', auth: 'basic', user: 'alice' } as const;

  expect(ExposeInputSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ExposeInputSchema rejects a user with token auth', () => {
  const result = ExposeInputSchema.safeParse({ name: 'dev', auth: 'token', user: 'alice' });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['user'], message: 'only basic auth takes a user' }),
  );
});

test('#ExposeInputSchema rejects a name that is not a valid name', () => {
  const result = ExposeInputSchema.safeParse({ name: 'Dev', auth: 'basic', user: 'alice' });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['name'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#ExposeInputSchema rejects an auth outside the auth list', () => {
  const result = ExposeInputSchema.safeParse({ name: 'dev', auth: 'password', user: 'alice' });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['auth'] }));
});

test('#ExposeInputSchema rejects a user with a colon', () => {
  const result = ExposeInputSchema.safeParse({ name: 'dev', auth: 'basic', user: 'al:ice' });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['user'],
      message: 'must be 1 to 64 printable characters, without a colon',
    }),
  );
});

test('#ExposeResultSchema accepts a result with a credential', () => {
  const payload = {
    url: 'https://dev.example.com',
    auth: 'basic',
    user: 'imp',
    credential: 's3cret',
  } as const;

  expect(ExposeResultSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ExposeResultSchema accepts a result with a warning and no auth', () => {
  const payload = {
    url: 'https://dev.example.com',
    auth: 'none',
    user: null,
    credential: null,
    warning: 'the DNS record is not written yet',
  } as const;

  expect(ExposeResultSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ExposeResultSchema rejects a url that is not a URL', () => {
  const result = ExposeResultSchema.safeParse({
    url: 'dev.example',
    auth: 'basic',
    user: 'imp',
    credential: 's3cret',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['url'] }));
});

test('#ExposeResultSchema rejects an auth outside the auth list', () => {
  const result = ExposeResultSchema.safeParse({
    url: 'https://dev.example.com',
    auth: 'password',
    user: 'imp',
    credential: 's3cret',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['auth'] }));
});
