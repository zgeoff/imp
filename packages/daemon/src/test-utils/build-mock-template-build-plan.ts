import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import type { TemplateBuildPlan } from '../vmm/template-vm';

type TemplateBuildPlanOverrides = Partial<Omit<TemplateBuildPlan, 'paths'>> & {
  readonly paths?: Partial<TemplateBuildPlan['paths']>;
};

// The cold boot a template is made from: unjailed, outside any cgroup, with
// no wait for the guest's age. Its run paths and snapshot follow its work
// dir; a `paths` override merges into those.
export function buildMockTemplateBuildPlan(
  overrides: TemplateBuildPlanOverrides = {},
): TemplateBuildPlan {
  const { paths: pathOverrides, ...rest } = overrides;

  const workDir =
    overrides.workDir ??
    `/data/templates/.build-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`;

  const runDir = join(workDir, 'run');
  const snapshotDir = join(workDir, 'snapshot');

  return {
    firecrackerBin: 'firecracker',
    kernelPath: '/data/system/vmlinux',
    systemDrivePath: `/data/system/drives/${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}.squashfs`,
    bootArgs: 'console=ttyS0 imp.template=1',
    vcpus: faker.number.int({ min: 1, max: 4 }),
    memoryMib: faker.helpers.arrayElement([128, 256, 512]),
    workDir,
    paths: {
      runDir,
      apiSocket: join(runDir, 'api.sock'),
      vsockSocket: join(runDir, 'vsock.sock'),
      logFile: join(runDir, 'firecracker.log'),
      pidFile: join(runDir, 'pid'),
      ...pathOverrides,
    },
    placeholderPath: join(workDir, 'placeholder.ext4'),
    tap: 'imp-tpl',
    guestMac: '06:00:a9:fe:ff:fe',
    jailId: `tpl-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`,
    jail: null,
    cgroup: null,
    minGuestUptimeMs: 0,
    snapshotDir,
    vmstate: join(snapshotDir, 'vmstate'),
    memFile: join(snapshotDir, 'mem'),
    ...rest,
  };
}
