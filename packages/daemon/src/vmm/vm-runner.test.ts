import { expect, test } from 'bun:test';
import { deriveSlotAddress, parseSubnet } from '../net/addressing';
import { buildImpPaths } from '../storage/data-layout';
import { buildBootArgs } from './vm-runner';

test('it builds the smoke-boot kernel cmdline with the slot addressing', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  const args = buildBootArgs({
    firecrackerBin: 'firecracker',
    kernelPath: '/k',
    systemDrivePath: '/s',
    paths: buildImpPaths('/var/lib/imp', 'id'),
    address,
    impId: 'id',
    hostname: 'dev',
    vcpus: 2,
    memoryMib: 1024,
    dns: ['1.1.1.1', '8.8.8.8'],
  });

  expect(args).toContain('root=/dev/vdb rootfstype=squashfs ro init=/imp-agent');
  expect(args).toContain('reboot=k');

  expect(args).toEndWith(
    'imp.id=id imp.hostname=dev imp.ip=10.66.0.14/30 imp.gw=10.66.0.13 imp.dns=1.1.1.1,8.8.8.8',
  );
});
