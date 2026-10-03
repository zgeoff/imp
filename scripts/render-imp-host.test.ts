import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  readHostArgs,
  render,
  renderCompose,
  renderExecStart,
  renderProbe,
  renderProxyExecStart,
} from './render-imp-host';

function readRepoFile(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

test('the units, bootstrap.sh and compose.yaml match deploy/imp-host.args.json', () => {
  const current = {
    unit: readRepoFile('deploy/imp-host.service'),
    proxyUnit: readRepoFile('deploy/imp-docker-proxy.service'),
    bootstrap: readRepoFile('deploy/bootstrap.sh'),
    compose: readRepoFile('deploy/compose.yaml'),
  };

  // on failure: bun run render:deploy
  expect(render(readRepoFile('deploy/imp-host.args.json'), current)).toEqual(current);
});

test('the deploy runs nothing --privileged', () => {
  const args = readHostArgs(readRepoFile('deploy/imp-host.args.json'));
  const words = [...args.privileges, ...args.lines, ...args.proxy.privileges, ...args.proxy.lines];

  expect(words.flat()).not.toContain('--privileged');
});

test('imp-host binds no docker.sock; only the proxy does, without capabilities or a network', () => {
  const args = readHostArgs(readRepoFile('deploy/imp-host.args.json'));
  const hostWords = [...args.privileges, ...args.lines].flat();
  const proxyWords = [...args.proxy.privileges, ...args.proxy.lines].flat();

  expect(hostWords.filter((word) => word.includes('docker.sock'))).toEqual([
    'DOCKER_HOST=unix:///run/imp-docker/docker.sock',
  ]);

  expect(hostWords).toContain('/run/imp-docker:/run/imp-docker:ro');
  expect(proxyWords).toContain('/var/run/docker.sock:/var/run/docker.sock');
  expect(proxyWords.join(' ')).toContain('--cap-drop ALL');
  expect(proxyWords).not.toContain('--cap-add');
  expect(proxyWords.join(' ')).toContain('--network none');
  expect(proxyWords.join(' ')).toContain('--security-opt no-new-privileges');
  expect(proxyWords.join(' ')).toContain('--user 65534:65534');
  expect(proxyWords).not.toContain('--env-file');
});

test("the proxy's ExecStart ends in the image and its command", () => {
  expect(
    renderProxyExecStart({
      privileges: [['--cap-drop', 'ALL']],
      lines: [
        ['--rm', '--name', 'p'],
        ['-e', 'X'],
      ],
      command: ['/usr/local/bin/imp-docker-proxy'],
    }),
  ).toBe(
    'ExecStart=/usr/bin/docker run --rm --name p \\\n  --cap-drop ALL \\\n  -e X \\\n' +
      `  \${IMP_HOST_IMAGE} /usr/local/bin/imp-docker-proxy`,
  );
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

const PROXY_JSON = '"proxy": {"privileges": [["--read-only"]], "lines": [["x"]], "command": ["y"]}';

function buildArgsJson(lines: string): string {
  return `{"privileges": [["--init"]], "probed": [], "lines": ${lines}, ${PROXY_JSON}}`;
}

test('an unbraced $NAME passes as env words in lines; a braced one does not', () => {
  expect(readHostArgs(buildArgsJson('[["$IMP_PUBLIC_PORTS"]]')).lines).toEqual([
    ['$IMP_PUBLIC_PORTS'],
  ]);

  expect(() => readHostArgs(buildArgsJson(`[["\${IMP_PUBLIC_PORTS}"]]`))).toThrow(
    'is not a plain word',
  );

  expect(() =>
    readHostArgs(
      `{"privileges": [["$IMP_PUBLIC_PORTS"]], "probed": [], "lines": [["x"]], ${PROXY_JSON}}`,
    ),
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
