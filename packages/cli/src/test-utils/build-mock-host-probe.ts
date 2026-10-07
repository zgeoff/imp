import { buildMockIdentity } from '@imp/api/test-utils/build-mock-identity';
import { buildMockSystemInfo } from '@imp/api/test-utils/build-mock-system-info';
import type { HostProbe } from '../place-imp';

// What placement reads from a host that would take an unnamed create: a
// manage token on every imp, no imps or networks, and the info's default
// image, so an info override keeps the host placeable.
export function buildMockHostProbe(overrides: Partial<HostProbe> = {}): HostProbe {
  const info = overrides.info ?? buildMockSystemInfo();
  const image = info.defaults?.image;

  return {
    info,
    identity: buildMockIdentity(),
    images: image === undefined || image === null ? [] : [image],
    imps: [],
    networks: [],
    ...overrides,
  };
}
