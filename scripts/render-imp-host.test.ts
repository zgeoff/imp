import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  readHostArgs,
  render,
  renderBootstrap,
  renderCompose,
  renderExecStart,
  renderProbe,
  renderProxyExecStart,
  renderProxyUnit,
  renderUnit,
} from './render-imp-host';

test('#render renders every deploy file from one args file', () => {
  const argsJson = JSON.stringify({
    privileges: [['--init', '--cap-add', 'KILL']],
    probed: [
      { path: '/dev/zfs', args: ['--device', '/dev/zfs'] },
      { path: '/proc/sys/net/ipv6', args: ['--sysctl', 'net.ipv6.conf.all.forwarding=1'] },
    ],
    lines: [
      ['--rm', '--name', 'imp-host'],
      ['-v', '/var/lib/imp:/data'],
    ],
    proxy: {
      privileges: [['--read-only', '--user', '65534:65534']],
      lines: [['--rm', '--name', 'imp-docker-proxy']],
      command: ['/usr/local/bin/imp-docker-proxy'],
    },
  });

  const current = {
    unit:
      "[Service]\nExecStartPre=/bin/sh -c 'a=; old'\n" +
      `ExecStart=/usr/bin/docker run --old \\\n  \${IMP_HOST_IMAGE}\n`,
    proxyUnit: `[Service]\nExecStart=/usr/bin/docker run --old \\\n  \${IMP_HOST_IMAGE} old\n`,
    bootstrap:
      "unit_imp_host() {\n  cat <<'EOF'\nold\nEOF\n}\n" +
      "unit_imp_docker_proxy() {\n  cat <<'EOF'\nold\nEOF\n}\n",
    compose:
      '    # proxy privileges: from deploy/imp-host.args.json (bun run render:deploy)\n' +
      '    old: true\n    # end of proxy privileges\n' +
      '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n' +
      '    old: true\n    # end of privileges\n',
  };

  expect(render(argsJson, current)).toMatchInlineSnapshot(`
    {
      "bootstrap": 
    "unit_imp_host() {
      cat <<'EOF'
    [Service]
    ExecStartPre=/bin/sh -c 'a=; [ -e /dev/zfs ] && a="$$a --device /dev/zfs"; [ -e /proc/sys/net/ipv6 ] && a="$$a --sysctl net.ipv6.conf.all.forwarding=1"; { echo "IMP_HOST_PROBED=$$a"; echo "IMP_HOST_ADDRESSES=$$(ip -o addr show scope global | tr -s " " | cut -d " " -f 4 | paste -sd ,)"; } >/run/imp-host/probed.env'
    ExecStart=/usr/bin/docker run --rm --name imp-host \\
      --init --cap-add KILL \\
      -v /var/lib/imp:/data \\
      $IMP_HOST_PROBED \\
      \${IMP_HOST_IMAGE}
    EOF
    }
    unit_imp_docker_proxy() {
      cat <<'EOF'
    [Service]
    ExecStart=/usr/bin/docker run --rm --name imp-docker-proxy \\
      --read-only --user 65534:65534 \\
      \${IMP_HOST_IMAGE} /usr/local/bin/imp-docker-proxy
    EOF
    }
    "
    ,
      "compose": 
    "    # proxy privileges: from deploy/imp-host.args.json (bun run render:deploy)
        read_only: true
        user: '65534:65534'
        # end of proxy privileges
        # privileges: from deploy/imp-host.args.json (bun run render:deploy)
        init: true
        cap_add:
          - KILL
        sysctls:
          - net.ipv6.conf.all.forwarding=1
        # end of privileges
    "
    ,
      "proxyUnit": 
    "[Service]
    ExecStart=/usr/bin/docker run --rm --name imp-docker-proxy \\
      --read-only --user 65534:65534 \\
      \${IMP_HOST_IMAGE} /usr/local/bin/imp-docker-proxy
    "
    ,
      "unit": 
    "[Service]
    ExecStartPre=/bin/sh -c 'a=; [ -e /dev/zfs ] && a="$$a --device /dev/zfs"; [ -e /proc/sys/net/ipv6 ] && a="$$a --sysctl net.ipv6.conf.all.forwarding=1"; { echo "IMP_HOST_PROBED=$$a"; echo "IMP_HOST_ADDRESSES=$$(ip -o addr show scope global | tr -s " " | cut -d " " -f 4 | paste -sd ,)"; } >/run/imp-host/probed.env'
    ExecStart=/usr/bin/docker run --rm --name imp-host \\
      --init --cap-add KILL \\
      -v /var/lib/imp:/data \\
      $IMP_HOST_PROBED \\
      \${IMP_HOST_IMAGE}
    "
    ,
    }
  `);
});

test('#render gives the same files for the same input', () => {
  const argsJson =
    '{"privileges": [["--init"]], "probed": [], "lines": [["--name", "x"]], ' +
    '"proxy": {"privileges": [["--read-only"]], "lines": [["--name", "p"]], "command": ["y"]}}';

  const current = {
    unit: `ExecStartPre=/bin/sh -c 'a=; old'\nExecStart=/usr/bin/docker run \\\n  \${IMP_HOST_IMAGE}\n`,
    proxyUnit: `ExecStart=/usr/bin/docker run \\\n  \${IMP_HOST_IMAGE} old\n`,
    bootstrap:
      "unit_imp_host() {\n  cat <<'EOF'\nold\nEOF\n}\n" +
      "unit_imp_docker_proxy() {\n  cat <<'EOF'\nold\nEOF\n}\n",
    compose:
      '    # proxy privileges: from deploy/imp-host.args.json (bun run render:deploy)\n' +
      '    # end of proxy privileges\n' +
      '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n' +
      '    # end of privileges\n',
  };

  expect(render(argsJson, current)).toStrictEqual(render(argsJson, current));
});

test('#render leaves the checked-in units, bootstrap.sh and compose.yaml as they are', () => {
  const current = {
    unit: readFileSync(new URL('../deploy/imp-host.service', import.meta.url), 'utf8'),
    proxyUnit: readFileSync(new URL('../deploy/imp-docker-proxy.service', import.meta.url), 'utf8'),
    bootstrap: readFileSync(new URL('../deploy/bootstrap.sh', import.meta.url), 'utf8'),
    compose: readFileSync(new URL('../deploy/compose.yaml', import.meta.url), 'utf8'),
  };

  const argsJson = readFileSync(new URL('../deploy/imp-host.args.json', import.meta.url), 'utf8');

  // on failure: bun run render:deploy
  expect(render(argsJson, current)).toStrictEqual(current);
});

test('#readHostArgs passes an unbraced $NAME in lines as env words', () => {
  const args = readHostArgs(
    '{"privileges": [["--init"]], "probed": [], "lines": [["$IMP_PUBLIC_PORTS"]], ' +
      '"proxy": {"privileges": [["--read-only"]], "lines": [["x"]], "command": ["y"]}}',
  );

  expect(args.lines).toStrictEqual([['$IMP_PUBLIC_PORTS']]);
});

test(`#readHostArgs refuses a braced \${NAME} in lines`, () => {
  expect(() =>
    readHostArgs(
      `{"privileges": [["--init"]], "probed": [], "lines": [["\${IMP_PUBLIC_PORTS}"]], ` +
        '"proxy": {"privileges": [["--read-only"]], "lines": [["x"]], "command": ["y"]}}',
    ),
  ).toThrowWithMessage(Error, /is not a plain word or \$NAME/u);
});

test('#readHostArgs refuses a $NAME in privileges', () => {
  expect(() =>
    readHostArgs(
      '{"privileges": [["$IMP_PUBLIC_PORTS"]], "probed": [], "lines": [["x"]], ' +
        '"proxy": {"privileges": [["--read-only"]], "lines": [["x"]], "command": ["y"]}}',
    ),
  ).toThrowWithMessage(Error, /is not a plain word/u);
});

test('#readHostArgs refuses a word that would need quoting', () => {
  expect(() =>
    readHostArgs(
      '{"privileges": [["--init"]], "probed": [], "lines": [["-v", "/a b:/c"]], ' +
        '"proxy": {"privileges": [["--read-only"]], "lines": [["x"]], "command": ["y"]}}',
    ),
  ).toThrowWithMessage(Error, /is not a plain word/u);
});

test('#readHostArgs refuses empty lines', () => {
  expect(() =>
    readHostArgs(
      '{"privileges": [["--init"]], "probed": [], "lines": [], ' +
        '"proxy": {"privileges": [["--read-only"]], "lines": [["x"]], "command": ["y"]}}',
    ),
  ).toThrowWithMessage(Error, /must be non-empty/u);
});

test('#readHostArgs refuses args without probed, naming the args file', () => {
  expect(() =>
    readHostArgs(
      '{"privileges": [["--init"]], "lines": [["x"]], ' +
        '"proxy": {"privileges": [["--read-only"]], "lines": [["x"]], "command": ["y"]}}',
    ),
  ).toThrowWithMessage(Error, /^deploy\/imp-host\.args\.json: .*\n.*at probed/u);
});

test('#renderProxyExecStart ends the line in the image and the command', () => {
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

test('#renderExecStart puts the name, the privileges, the rest, the probed args, then the image', () => {
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

test('#renderProbe escapes its dollars for systemd', () => {
  expect(renderProbe([{ path: '/dev/zfs', args: ['--device', '/dev/zfs'] }])).toBe(
    'ExecStartPre=/bin/sh -c \'a=; [ -e /dev/zfs ] && a="$$a --device /dev/zfs"; ' +
      '{ echo "IMP_HOST_PROBED=$$a"; echo "IMP_HOST_ADDRESSES=$$(ip -o addr show scope global | ' +
      'tr -s " " | cut -d " " -f 4 | paste -sd ,)"; } >/run/imp-host/probed.env\'',
  );
});

test('#renderCompose writes a compose key for each privilege flag', () => {
  const compose =
    '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n    # end of privileges\n';

  expect(renderCompose(compose, [['--init', '--cap-add', 'KILL', '--cap-add', 'MKNOD']])).toBe(
    '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n' +
      '    init: true\n    cap_add:\n      - KILL\n      - MKNOD\n    # end of privileges\n',
  );
});

test('#renderCompose refuses a privilege flag it has no compose key for', () => {
  const compose =
    '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n    # end of privileges\n';

  expect(() => renderCompose(compose, [['--pid=host']])).toThrowWithMessage(
    Error,
    'deploy/imp-host.args.json: no compose key for the privilege --pid=host',
  );
});

test('#renderCompose refuses a compose file without the privileges block', () => {
  expect(() => renderCompose('services: {}\n', [['--init']])).toThrowWithMessage(
    Error,
    'deploy/compose.yaml: no block from "# privileges: from deploy/imp-host.args.json (bun run render:deploy)"',
  );
});

test('#renderUnit refuses a unit whose docker run does not end in the image', () => {
  expect(() =>
    renderUnit("ExecStartPre=/bin/sh -c 'a=; x'\nExecStart=/usr/bin/docker run imp-host\n", {
      privileges: [['--init']],
      probed: [],
      lines: [['x']],
      proxy: { privileges: [['--read-only']], lines: [['x']], command: ['y'] },
    }),
  ).toThrowWithMessage(
    Error,
    `deploy/imp-host.service: no docker run ExecStart that ends in \${IMP_HOST_IMAGE}`,
  );
});

test('#renderUnit refuses a unit without the probe', () => {
  expect(() =>
    renderUnit(`ExecStart=/usr/bin/docker run \\\n  \${IMP_HOST_IMAGE}\n`, {
      privileges: [['--init']],
      probed: [],
      lines: [['x']],
      proxy: { privileges: [['--read-only']], lines: [['x']], command: ['y'] },
    }),
  ).toThrowWithMessage(
    Error,
    "deploy/imp-host.service: no ExecStartPre=/bin/sh -c '...' for the probed args",
  );
});

test('#renderProxyUnit refuses a unit whose docker run has no command after the image', () => {
  expect(() =>
    renderProxyUnit(`ExecStart=/usr/bin/docker run \\\n  \${IMP_HOST_IMAGE}\n`, {
      privileges: [['--read-only']],
      lines: [['x']],
      command: ['y'],
    }),
  ).toThrowWithMessage(
    Error,
    `deploy/imp-docker-proxy.service: no docker run ExecStart with \${IMP_HOST_IMAGE} and a command`,
  );
});

test('#renderBootstrap refuses a bootstrap.sh without the proxy unit heredoc', () => {
  expect(() =>
    renderBootstrap("unit_imp_host() {\n  cat <<'EOF'\nold\nEOF\n}\n", 'unit', 'proxy unit'),
  ).toThrowWithMessage(Error, 'deploy/bootstrap.sh: no heredoc from "unit_imp_docker_proxy"');
});

test('#render refuses a compose file without the proxy privileges block', () => {
  const argsJson =
    '{"privileges": [["--init"]], "probed": [], "lines": [["--name", "x"]], ' +
    '"proxy": {"privileges": [["--read-only"]], "lines": [["--name", "p"]], "command": ["y"]}}';

  const current = {
    unit: `ExecStartPre=/bin/sh -c 'a=; old'\nExecStart=/usr/bin/docker run \\\n  \${IMP_HOST_IMAGE}\n`,
    proxyUnit: `ExecStart=/usr/bin/docker run \\\n  \${IMP_HOST_IMAGE} old\n`,
    bootstrap:
      "unit_imp_host() {\n  cat <<'EOF'\nold\nEOF\n}\n" +
      "unit_imp_docker_proxy() {\n  cat <<'EOF'\nold\nEOF\n}\n",
    compose:
      '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n' +
      '    # end of privileges\n',
  };

  expect(() => render(argsJson, current)).toThrowWithMessage(
    Error,
    'deploy/compose.yaml: no block from "# proxy privileges: from deploy/imp-host.args.json (bun run render:deploy)"',
  );
});

test('#renderBootstrap refuses a bootstrap.sh without the unit heredoc', () => {
  expect(() => renderBootstrap('main() { :; }\n', 'unit', 'proxy unit')).toThrowWithMessage(
    Error,
    'deploy/bootstrap.sh: no heredoc from "unit_imp_host"',
  );
});
