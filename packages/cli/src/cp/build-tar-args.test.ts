import { expect, test } from 'bun:test';
import { readAgentFixture } from '@impz/test-utils/read-agent-fixture';
import * as z from 'zod';
import { buildTarArgs } from './build-tar-args';

// agent/internal/contract/testdata/host/tar.json holds the argv the agent's
// tar tool parses; each test builds one of them

test('it builds the argv of a download as the tar tool takes it', () => {
  const fixture = z
    .object({ create: z.array(z.string()) })
    .parse(readAgentFixture('host/tar.json'));

  expect(buildTarArgs({ op: 'create', path: 'src/app' })).toStrictEqual(fixture.create);
});

test('it builds the argv of an upload as the tar tool takes it', () => {
  const fixture = z
    .object({ extract: z.array(z.string()) })
    .parse(readAgentFixture('host/tar.json'));

  expect(buildTarArgs({ op: 'extract', path: '/srv/drop' })).toStrictEqual(fixture.extract);
});

test('it builds the argv of an upload with an owner as the tar tool takes it', () => {
  const fixture = z
    .object({ extract_owner: z.array(z.string()) })
    .parse(readAgentFixture('host/tar.json'));

  expect(buildTarArgs({ op: 'extract', path: '/srv/drop', owner: 'dev' })).toStrictEqual(
    fixture.extract_owner,
  );
});
