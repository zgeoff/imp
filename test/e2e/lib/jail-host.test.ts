import { expect, test } from 'bun:test';
import { checkTemplateBuildEnded, findJailViolations, readStatusField } from './jail-host';

test('#checkTemplateBuildEnded sees the end of the imp’s own template build', () => {
  const log = 'impd: boot template 0e61ca281a1c build failed: no agent\n';

  expect(checkTemplateBuildEnded(log, 'e2e-jail-rm', '0e61ca281a1c9f00')).toBeTrue();
});

test('#checkTemplateBuildEnded passes over the end of another key’s build', () => {
  const log = 'impd: boot template 7a2b44c0d1e3 built in 900ms\n';

  expect(checkTemplateBuildEnded(log, 'e2e-jail-rm', '0e61ca281a1c9f00')).toBeFalse();
});

test('#checkTemplateBuildEnded sees a restore, which starts no build', () => {
  const log = 'impd: e2e-jail-rm: restored boot template 0e61ca281a1c as pid 9\n';

  expect(checkTemplateBuildEnded(log, 'e2e-jail-rm', '0e61ca281a1c9f00')).toBeTrue();
});

test('#readStatusField reads a field of a process status', () => {
  const status =
    'Name:\tfirecracker\nUid:\t900001\t900001\t900001\t900001\nCapEff:\t0000000000000000\n';

  expect(readStatusField(status, 'Uid')).toBe('900001\t900001\t900001\t900001');
});

test('#readStatusField reads a missing field as empty', () => {
  expect(readStatusField('Name:\tfirecracker\n', 'CapEff')).toBe('');
});

test('#findJailViolations finds none in a jailed VM', () => {
  expect(
    findJailViolations({
      impId: 'abc',
      cmdline:
        '/firecracker --id abc --start-time-us 1 -- --api-sock /var/lib/imp/imps/abc/run/api.sock',
      uid: '900001',
      capEff: '0000000000000000',
      seccompModes: ['2', '2', '2'],
      tapOwner: '900001',
      sealedOwners: ['0', '0'],
    }),
  ).toStrictEqual([]);
});

test('#findJailViolations names each break of a VM run as root by an impd without the jailer', () => {
  expect(
    findJailViolations({
      impId: 'abc',
      cmdline: '/usr/local/bin/firecracker --api-sock /var/lib/imp/imps/abc/run/api.sock',
      uid: '0',
      capEff: '000001ffffffffff',
      seccompModes: ['2', '0'],
      tapOwner: '',
      sealedOwners: ['0', '900001'],
    }),
  ).toStrictEqual([
    'not started by the jailer',
    'uid 0',
    'capabilities 000001ffffffffff',
    'seccomp 2,0',
    'tap owned by ',
    'run/ and snapshot/ owned by 0,900001',
  ]);
});

test('#findJailViolations names a VM whose filters cover one thread only', () => {
  expect(
    findJailViolations({
      impId: 'abc',
      cmdline: '/firecracker --id abc -- --api-sock /var/lib/imp/imps/other/run/api.sock',
      uid: '900001',
      capEff: '0000000000000000',
      seccompModes: ['2'],
      tapOwner: '900001',
      sealedOwners: ['0', '0'],
    }),
  ).toStrictEqual(['another API socket', '1 threads']);
});
