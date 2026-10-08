import type { Identity, SystemInfo } from '@imp/api';
import { buildMockIdentity } from '@imp/api/test-utils/build-mock-identity';
import { buildMockSystemInfo } from '@imp/api/test-utils/build-mock-system-info';
import type { HostProbe } from '../place-imp';

// the parts of the info an older impd leaves out
type OptionalInfoKey = {
  [K in keyof SystemInfo]-?: undefined extends SystemInfo[K] ? K : never;
}[keyof SystemInfo];

interface HostProbeOverrides {
  // merged into a current impd's info, as buildMockSystemInfo merges
  readonly info?: Parameters<typeof buildMockSystemInfo>[0];

  // the optional parts of the info that are absent, as on an older impd
  readonly withoutInfo?: readonly OptionalInfoKey[];
  readonly identity?: Partial<Identity>;
  readonly images?: readonly string[];
  readonly imps?: readonly string[];
  readonly networks?: readonly string[];
}

// What placement reads from a host that would take an unnamed create: a
// manage token on every imp, no imps or networks, and the info's default
// image, so an info override keeps the host placeable.
export function buildMockHostProbe(overrides: Readonly<HostProbeOverrides> = {}): HostProbe {
  const info: SystemInfo = { ...buildMockSystemInfo(overrides.info) };

  for (const key of overrides.withoutInfo ?? []) {
    Reflect.deleteProperty(info, key);
  }

  const image = info.defaults?.image;

  return {
    info,
    identity: buildMockIdentity(overrides.identity),
    images: overrides.images ?? (image === undefined || image === null ? [] : [image]),
    imps: overrides.imps ?? [],
    networks: overrides.networks ?? [],
  };
}
