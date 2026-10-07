import { expect, test } from 'bun:test';
import { checkReleaseRefs } from './check-release-refs';

test('it counts a reference to the release under an inline marker as a default', () => {
  const text = 'image: ghcr.io/zgeoff/imp-host:1.2.3 # x-release-please-version\n';

  expect(checkReleaseRefs('compose.yaml', text, '1.2.3')).toStrictEqual({
    problems: [],
    defaults: 1,
  });
});

test('it counts every reference inside a marker block as a default', () => {
  const text = [
    '# x-release-please-start-version',
    'IMAGE=ghcr.io/zgeoff/imp-host:1.2.3',
    'curl https://raw.githubusercontent.com/zgeoff/imp/v1.2.3/deploy/bootstrap.sh',
    '# x-release-please-end',
  ].join('\n');

  expect(checkReleaseRefs('a.sh', text, '1.2.3')).toStrictEqual({ problems: [], defaults: 2 });
});

test('it reports a reference to the release under no marker', () => {
  expect(checkReleaseRefs('a.sh', 'IMAGE=ghcr.io/zgeoff/imp-host:1.2.3\n', '1.2.3')).toStrictEqual({
    problems: ['a.sh:1: ghcr.io/zgeoff/imp-host:1.2.3 is under no marker'],
    defaults: 0,
  });
});

test('it reports a reference to another release in code', () => {
  const text = 'IMAGE=ghcr.io/zgeoff/imp-host:1.0.0 # x-release-please-version\n';

  expect(checkReleaseRefs('a.sh', text, '1.2.3')).toStrictEqual({
    problems: ['a.sh:1: ghcr.io/zgeoff/imp-host:1.0.0 is not this release (1.2.3)'],
    defaults: 0,
  });
});

test("it lets a guide's prose name another tag, but not its code", () => {
  const text = [
    'Pin ghcr.io/zgeoff/imp-host:latest if you must.',
    '```sh',
    'docker pull ghcr.io/zgeoff/imp-host:latest',
    '```',
  ].join('\n');

  expect(checkReleaseRefs('guide.md', text, '1.2.3')).toStrictEqual({
    problems: ['guide.md:3: ghcr.io/zgeoff/imp-host:latest is not this release (1.2.3)'],
    defaults: 0,
  });
});

test('it lets the definition of the old template line name latest', () => {
  const text = "readonly LEGACY_IMAGE_LINE='IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest'\n";

  expect(checkReleaseRefs('upgrade.sh', text, '1.2.3')).toStrictEqual({
    problems: [],
    defaults: 0,
  });
});

test('it reports a deploy file fetched from main', () => {
  const text = 'curl https://raw.githubusercontent.com/zgeoff/imp/main/deploy/bootstrap.sh\n';

  expect(checkReleaseRefs('install.md', text, '1.2.3')).toStrictEqual({
    problems: ['install.md:1: fetches from main, not this release'],
    defaults: 0,
  });
});

test('it reports a marked line whose first X.Y.Z is no release reference', () => {
  const text =
    'needs docker 25.0.0, image ghcr.io/zgeoff/imp-host:1.2.3 # x-release-please-version\n';

  expect(checkReleaseRefs('a.sh', text, '1.2.3')).toStrictEqual({
    problems: ['a.sh:1: the first X.Y.Z, 25.0.0, is not a release reference'],
    defaults: 1,
  });
});
