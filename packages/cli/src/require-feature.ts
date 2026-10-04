import type { ImpClient } from './create-imp-client';

// impd features a call relies on (SystemInfo.features), and what an impd
// without one is
const FEATURES = {
  grantableTokens: 'is older than 0.27.0',
  secretRebind: 'is older than 0.27.0',
  databaseCopy: 'is older than 0.30.0',
  execRequire: 'is older than 0.30.0',
  sessionLog: 'has no session logs',
  publicEgress: 'is older than 0.33.0',
} as const;

type Feature = keyof typeof FEATURES;

// An impd drops input fields it does not know and fails on values it does
// not know, so a call that relies on a newer one asks first, before it
// writes anything. `outcome` says what the older impd would do instead.
export async function requireFeature(
  client: Pick<ImpClient, 'system'>,
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
