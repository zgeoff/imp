import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './instance';
import type { HostConfig } from './privileges';
import { findPrivilegeDrift, readExpectedPrivileges } from './privileges';

const seccompJson = readFileSync(join(REPO_ROOT, 'deploy', 'imp-host.seccomp.json'), 'utf8');

const expected = readExpectedPrivileges(
  readFileSync(join(REPO_ROOT, 'deploy', 'imp-host.args.json'), 'utf8'),
  seccompJson,
);

// what docker inspect shows for a container run with the deploy's privileges
const deployed: HostConfig = {
  Privileged: false,
  CapAdd: [...expected.caps],
  CapDrop: ['ALL'],

  // inline and compact, as docker inspect shows it
  SecurityOpt: [...expected.securityOpts, `seccomp=${JSON.stringify(JSON.parse(seccompJson))}`],
  Devices: expected.devices.map((path) => ({ PathOnHost: path })),
};

describe('findPrivilegeDrift', () => {
  test('passes the deploy privileges, with a probed and a dev device', () => {
    expect(findPrivilegeDrift(deployed, expected)).toBeNull();

    expect(
      findPrivilegeDrift(
        {
          ...deployed,
          Devices: [
            ...(deployed.Devices ?? []),
            { PathOnHost: '/dev/zfs' },
            { PathOnHost: '/dev/loop-control' },
          ],
        },
        expected,
      ),
    ).toBeNull();
  });

  test('flags --privileged', () => {
    expect(findPrivilegeDrift({ ...deployed, Privileged: true }, expected)).toContain(
      '--privileged',
    );
  });

  test('flags the default capability set', () => {
    expect(findPrivilegeDrift({ ...deployed, CapDrop: null }, expected)).toContain(
      '--cap-drop ALL',
    );
  });

  test('flags a missing capability', () => {
    expect(
      findPrivilegeDrift(
        { ...deployed, CapAdd: expected.caps.filter((cap) => cap !== 'CAP_KILL') },
        expected,
      ),
    ).toContain('not');
  });

  test('flags AppArmor confinement', () => {
    expect(
      findPrivilegeDrift(
        {
          ...deployed,
          SecurityOpt: (deployed.SecurityOpt ?? []).filter((opt) => !opt.startsWith('apparmor')),
        },
        expected,
      ),
    ).toContain('security options');
  });

  test('flags another seccomp profile, or none', () => {
    const others = expected.securityOpts;

    expect(
      findPrivilegeDrift(
        { ...deployed, SecurityOpt: [...others, 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'] },
        expected,
      ),
    ).toContain('seccomp profile');

    expect(findPrivilegeDrift({ ...deployed, SecurityOpt: [...others] }, expected)).toContain(
      '0 seccomp',
    );
  });

  test('flags a missing device and a host device it should not have', () => {
    expect(
      findPrivilegeDrift({ ...deployed, Devices: [{ PathOnHost: '/dev/kvm' }] }, expected),
    ).toContain('lack /dev/net/tun');

    expect(
      findPrivilegeDrift(
        { ...deployed, Devices: [...(deployed.Devices ?? []), { PathOnHost: '/dev/sda' }] },
        expected,
      ),
    ).toContain('add /dev/sda');
  });
});

test('readExpectedPrivileges reads the deploy privileges', () => {
  expect(expected.caps).toContain('CAP_SYS_ADMIN');
  expect(expected.caps).not.toContain('CAP_SYS_MODULE');
  expect(expected.securityOpts).toEqual(['apparmor=unconfined']);
  expect(expected.devices).toEqual(['/dev/kvm', '/dev/net/tun']);
  expect(expected.optionalDevices).toContain('/dev/zfs');
});
