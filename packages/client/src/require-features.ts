import type { SystemFeaturesInfo, SystemInfo } from '@impz/api';
import { ORPCError } from '@orpc/client';
import type { CallOptions } from './types';
import { UnknownProcedureError } from './unknown-procedure-error';

export type ImpdFeatures = SystemFeaturesInfo['features'];

export type ImpdFeature = keyof ImpdFeatures;

// what an impd without each feature is, after "this impd"
const FEATURE_GAPS = {
  sessionOffsets: 'has no session offsets',
  leases: 'has no leases',
  grantableTokens: 'is older than 0.27.0',
  secretRebind: 'is older than 0.27.0',
  tokenUpdate: 'is older than 0.34.0',
  tokenImageAdd: 'has no token image adds',
  databaseCopy: 'is older than 0.30.0',
  imageBuildStream: 'has no build stream',
  imageOpStream: 'has no image add or build streams',
  imageBuilds: 'has no list of running image builds',
  execRequire: 'is older than 0.30.0',
  oauthGrants: 'has no oauth grants',
  secretFilesGc: 'has no gc of secret files',
  sessionLog: 'has no session logs',
  publicEgress: 'is older than 0.35.0',
  oauthSecrets: 'has no oauth secrets',
  secretUpstream: 'has no secret upstreams',
  backupOptOut: 'has no backup opt-out',
  brokerRefusals: 'has no audit of refused broker requests',
  grantFilters: 'has no grant filters',
  readOnlyFiles: 'has no read-only files',
  execDropSysAdmin: 'cannot drop CAP_SYS_ADMIN from a command',
} as const satisfies Record<ImpdFeature, string>;

// the feature calls of a client: any client of impd passes
export interface FeatureSource {
  readonly system: {
    readonly features: (input?: undefined, options?: CallOptions) => Promise<SystemFeaturesInfo>;
    readonly info: (input?: undefined, options?: CallOptions) => Promise<SystemInfo>;
  };
}

// each feature a call relies on, with what an impd without it would do
// instead, such as `drop --grantable and make the token without that limit`
export type FeatureNeeds = Partial<Readonly<Record<ImpdFeature, string>>>;

// impd lacks a feature the call relies on; nothing was sent
export class MissingFeatureError extends Error {
  override name = 'MissingFeatureError';

  readonly feature: ImpdFeature;

  // what this impd is, such as `is older than 0.30.0`, and what it would
  // do with the call
  readonly gap: string;

  readonly outcome: string;

  constructor(feature: ImpdFeature, gap: string, outcome: string) {
    super(`this impd ${gap} and would ${outcome}; nothing was changed`);

    this.feature = feature;
    this.gap = gap;
    this.outcome = outcome;
  }
}

// An impd drops input fields it does not know, so a call that relies on a
// newer one asks first. One read covers every need, an empty `needs` reads
// nothing, and the first need missing throws a MissingFeatureError.
export async function requireFeatures(
  client: FeatureSource,
  needs: FeatureNeeds,
  options: CallOptions = {},
): Promise<void> {
  if (Object.keys(needs).length === 0) {
    return;
  }

  const features = await readFeatures(client, options);

  for (const [feature, outcome] of Object.entries(needs)) {
    if (isImpdFeature(feature) && outcome !== undefined && features[feature] !== true) {
      throw new MissingFeatureError(feature, FEATURE_GAPS[feature], outcome);
    }
  }
}

// impd's feature flags, from system.features; an impd older than it
// answers NOT_FOUND, and its system.info carries them, or none at all
export async function readFeatures(
  client: FeatureSource,
  options: CallOptions = {},
): Promise<Partial<ImpdFeatures>> {
  try {
    // the client does not check answers; one with no flags has none on
    const answer: Partial<SystemFeaturesInfo> = await client.system.features(undefined, options);

    return answer.features ?? {};
  } catch (error) {
    if (!isMissingProcedure(error)) {
      throw error;
    }
  }

  const info = await client.system.info(undefined, options);

  return info.features ?? {};
}

// the features of `wanted` a system.info answer lacks, for a caller that
// read it anyway
export function findMissingFeatures(
  info: Pick<SystemInfo, 'features'>,
  wanted: readonly ImpdFeature[],
): ImpdFeature[] {
  return wanted.filter((feature) => info.features?.[feature] !== true);
}

// impd's own plain-text 404 for a path no procedure matches, or the
// NOT_FOUND an oRPC router sends for one
function isMissingProcedure(error: unknown): boolean {
  return (
    error instanceof UnknownProcedureError || (error instanceof ORPCError && error.status === 404)
  );
}

function isImpdFeature(key: string): key is ImpdFeature {
  return Object.hasOwn(FEATURE_GAPS, key);
}
