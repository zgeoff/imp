import { faker } from '@faker-js/faker';
import { buildImpPaths } from '../storage/data-layout';
import type { TemplateRestorePlan } from '../vmm/template-vm';

// One imp's restore of a template: unjailed, outside any cgroup, its disk
// ready at once. Its disk path follows its paths, and the claim's id theirs.
export function buildMockTemplateRestorePlan(
  overrides: Partial<TemplateRestorePlan> = {},
): TemplateRestorePlan {
  const paths =
    overrides.paths ??
    buildImpPaths('/data', faker.string.alphanumeric({ length: 12, casing: 'lower' }));

  const templateDir = `/data/templates/${faker.string.hexadecimal({ length: 12, casing: 'lower', prefix: '' })}`;

  return {
    firecrackerBin: 'firecracker',
    paths,
    vmstate: `${templateDir}/vmstate`,
    memFile: `${templateDir}/mem`,
    systemDrivePath: `/data/system/drives/${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}.squashfs`,
    placeholderPath: `${templateDir}/placeholder.ext4`,
    diskPath: paths.disk,
    tap: `imp-${faker.string.alphanumeric({ length: 6, casing: 'lower' })}`,
    cgroup: null,
    jail: null,
    diskReady: Promise.resolve(faker.number.int({ min: 1, max: 64 }) * 1024 ** 3),
    claim: {
      id: paths.impId,
      hostname: faker.internet.domainWord(),
      ip: '10.66.0.2/30',
      gw: '10.66.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: faker.internet.mac(),
      seed: new Uint8Array(64),
      isIdentityReset: false,
    },
    ...overrides,
  };
}
