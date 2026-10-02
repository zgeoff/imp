import { join } from 'node:path';
import * as z from 'zod';

// a DNS label's head: with an imp's name it makes the service's label
const PrefixSchema = z
  .string()
  .regex(
    /^[a-z][a-z\d-]{0,20}$/,
    'IMP_TAILNET_NAME_PREFIX must be a lowercase letter followed by up to 20 letters, digits or hyphens',
  );

export const TailnetNamesEnvSchema = z.object({
  IMP_TAILNET_NAMES: z.literal('1').optional(),
  IMP_TAILNET_NAME_PREFIX: PrefixSchema.optional(),
  IMP_TAILNET_OAUTH_FILE: z.string().optional(),
});

export interface TailnetNamesConfig {
  // `svc:<prefix><imp name>`; empty gives the imp's own name
  readonly prefix: string;

  // a 0600 JSON file with the OAuth client's id and secret; impd reads it
  // when it needs a token, so the secret is never in its env or config
  readonly oauthFile: string;
}

// null unless IMP_TAILNET_NAMES=1 (docs/guides/tailscale.md#per-imp-names)
export function parseTailnetNamesConfig(
  env: z.infer<typeof TailnetNamesEnvSchema>,
  dataDir: string,
  isOnTailnet: boolean,
): TailnetNamesConfig | null {
  if (env.IMP_TAILNET_NAMES === undefined) {
    return null;
  }

  if (!isOnTailnet) {
    throw new Error(
      'IMP_TAILNET_NAMES=1 needs the host on the tailnet (TAILSCALE_AUTHKEY or IMP_TAILSCALE_NODE=1)',
    );
  }

  return {
    prefix: env.IMP_TAILNET_NAME_PREFIX ?? '',
    oauthFile: env.IMP_TAILNET_OAUTH_FILE ?? join(dataDir, 'tailnet-names', 'oauth.json'),
  };
}
