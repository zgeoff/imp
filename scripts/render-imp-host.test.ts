import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readArgLines, render, renderExecStart } from './render-imp-host';

function readRepoFile(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

test('the unit and bootstrap.sh match deploy/imp-host.args.json', () => {
  const unit = readRepoFile('deploy/imp-host.service');
  const bootstrap = readRepoFile('deploy/bootstrap.sh');
  const rendered = render(readRepoFile('deploy/imp-host.args.json'), unit, bootstrap);

  // on failure: bun run render:deploy
  expect(rendered.unit).toBe(unit);
  expect(rendered.bootstrap).toBe(bootstrap);
});

test('each line of words becomes one line of the unit, and the image ends it', () => {
  expect(
    renderExecStart([
      ['--rm', '--name', 'x'],
      ['-v', '/a:/b'],
    ]),
  ).toBe(`ExecStart=/usr/bin/docker run --rm --name x \\\n  -v /a:/b \\\n  \${IMP_HOST_IMAGE}`);
});

test('an unbraced $NAME passes as env words; a braced one does not', () => {
  expect(readArgLines('{"lines": [["$IMP_PUBLIC_PORTS"]]}')).toEqual([['$IMP_PUBLIC_PORTS']]);

  expect(() => readArgLines(`{"lines": [["\${IMP_PUBLIC_PORTS}"]]}`)).toThrow(
    'is not a plain word',
  );
});

test('a word that would need quoting is refused', () => {
  expect(() => readArgLines('{"lines": [["-v", "/a b:/c"]]}')).toThrow('is not a plain word');
  expect(() => readArgLines('{"lines": []}')).toThrow('non-empty');
});
