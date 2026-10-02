import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  readHostArgs,
  render,
  renderCompose,
  renderExecStart,
  renderProbe,
} from './render-imp-host';

function readRepoFile(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

test('the unit, bootstrap.sh and compose.yaml match deploy/imp-host.args.json', () => {
  const current = {
    unit: readRepoFile('deploy/imp-host.service'),
    bootstrap: readRepoFile('deploy/bootstrap.sh'),
    compose: readRepoFile('deploy/compose.yaml'),
  };

  // on failure: bun run render:deploy
  expect(render(readRepoFile('deploy/imp-host.args.json'), current)).toEqual(current);
});

test('the deploy runs nothing --privileged', () => {
  const args = readHostArgs(readRepoFile('deploy/imp-host.args.json'));

  expect([...args.privileges, ...args.lines].flat()).not.toContain('--privileged');
});

test('the name, the privileges, the rest, the probed args, then the image', () => {
  expect(
    renderExecStart({
      privileges: [['--cap-drop', 'ALL']],
      probed: [],
      lines: [
        ['--rm', '--name', 'x'],
        ['-v', '/a:/b'],
      ],
    }),
  ).toBe(
    'ExecStart=/usr/bin/docker run --rm --name x \\\n  --cap-drop ALL \\\n  -v /a:/b \\\n' +
      `  $IMP_HOST_PROBED \\\n  \${IMP_HOST_IMAGE}`,
  );
});

test('the probe escapes its dollars for systemd', () => {
  expect(renderProbe([{ path: '/dev/zfs', args: ['--device', '/dev/zfs'] }])).toBe(
    'ExecStartPre=/bin/sh -c \'a=; [ -e /dev/zfs ] && a="$$a --device /dev/zfs"; ' +
      'echo "IMP_HOST_PROBED=$$a" >/run/imp-host/probed.env\'',
  );
});

test('compose gets a key per privilege flag, and refuses one it has no key for', () => {
  const compose =
    '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n    # end of privileges\n';

  expect(renderCompose(compose, [['--init', '--cap-add', 'KILL', '--cap-add', 'MKNOD']])).toBe(
    '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n' +
      '    init: true\n    cap_add:\n      - KILL\n      - MKNOD\n    # end of privileges\n',
  );

  expect(() => renderCompose(compose, [['--pid=host']])).toThrow('no compose key');
});

function buildArgsJson(lines: string): string {
  return `{"privileges": [["--init"]], "probed": [], "lines": ${lines}}`;
}

test('an unbraced $NAME passes as env words in lines; a braced one does not', () => {
  expect(readHostArgs(buildArgsJson('[["$IMP_PUBLIC_PORTS"]]')).lines).toEqual([
    ['$IMP_PUBLIC_PORTS'],
  ]);

  expect(() => readHostArgs(buildArgsJson(`[["\${IMP_PUBLIC_PORTS}"]]`))).toThrow(
    'is not a plain word',
  );

  expect(() =>
    readHostArgs('{"privileges": [["$IMP_PUBLIC_PORTS"]], "probed": [], "lines": [["x"]]}'),
  ).toThrow('is not a plain word');
});

test('a word that would need quoting is refused', () => {
  expect(() => readHostArgs(buildArgsJson('[["-v", "/a b:/c"]]'))).toThrow('is not a plain word');
  expect(() => readHostArgs(buildArgsJson('[]'))).toThrow('non-empty');
  expect(() => readHostArgs('{"privileges": [["--init"]], "lines": [["x"]]}')).toThrow('probed');
});

test('compose.zfs.yaml passes every probed device', () => {
  const override = readRepoFile('deploy/compose.zfs.yaml');
  const probed = readHostArgs(readRepoFile('deploy/imp-host.args.json')).probed;

  for (const entry of probed.filter((each) => each.args[0] === '--device')) {
    expect(override).toContain(`- ${entry.path}`);
  }
});
