import { faker } from '@faker-js/faker';
import type { CliConfig } from '../cli-config';
import type { SavedTarget } from '../fan-out';

interface SavedTargetOverrides {
  readonly host?: string;
  readonly config?: Partial<CliConfig>;
}

// A saved host as listSavedTargets gives it: its config names the same host,
// with a URL and a token of its own. A config override merges into the
// defaults.
export function buildMockSavedTarget(overrides: SavedTargetOverrides = {}): SavedTarget {
  const host = overrides.host ?? faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/);

  const config: CliConfig = {
    url: faker.internet.url({ appendSlash: false }),
    token: faker.string.alphanumeric(24),
    host,
  };

  return { host, config: { ...config, ...overrides.config } };
}
