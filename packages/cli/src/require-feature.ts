import type { SystemInfo } from '@imp/api';

// impd features a call relies on (SystemInfo.features), and what an impd
// without one is
const FEATURES = {
  grantableTokens: 'is older than 0.27.0',
  secretRebind: 'is older than 0.27.0',
  databaseCopy: 'is older than 0.30.0',
  execRequire: 'is older than 0.30.0',
  sessionLog: 'has no session logs',
  tokenUpdate: 'is older than 0.34.0',
  publicEgress: 'is older than 0.35.0',
  oauthSecrets: 'has no oauth secrets',
  secretUpstream: 'has no secret upstreams',
} as const;

type Feature = keyof typeof FEATURES;

// only impd's answer to system.info, so any client of it passes
interface FeatureSource {
  readonly system: { readonly info: () => Promise<SystemInfo> };
}

// An impd drops input fields it does not know and fails on values it does
// not know, so a call that relies on a newer one asks first, before it
// writes anything. `outcome` says what the older impd would do instead.
export async function requireFeature(
  client: FeatureSource,
  feature: Feature,
  outcome: string,
): Promise<void> {
  const info = await client.system.info();

  if (info.features?.[feature] !== true) {
    throw new Error(
      `this impd ${FEATURES[feature]} and would ${outcome}; nothing was changed. Upgrade impd, or use an older imp CLI`,
    );
  }
}
