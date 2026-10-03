import type { ImpClient } from './create-imp-client';

// impd features a call relies on (SystemInfo.features)
type Feature = 'grantableTokens' | 'secretRebind';

// An impd drops input fields it does not know, so a call that relies on a
// newer one asks first, before it writes anything. `outcome` says what the
// older impd would do instead.
export async function requireFeature(
  client: Pick<ImpClient, 'system'>,
  feature: Feature,
  outcome: string,
): Promise<void> {
  const info = await client.system.info();

  if (info.features?.[feature] !== true) {
    throw new Error(
      `this impd is older than 0.27.0 and would ${outcome}; nothing was changed. Upgrade impd, or use an older imp CLI`,
    );
  }
}
