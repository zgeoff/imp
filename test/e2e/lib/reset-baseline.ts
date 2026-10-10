import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImpClient } from '../../../packages/client/src/index';

export interface ResetBaselineOptions {
  // impd's API as the run's root token reaches it
  readonly client: ImpClient;

  // the suites' prefixes (suites.ts): what a journey names with one is its own
  readonly prefixes: readonly string[];

  // where a journey may leave the broker's test upstreams file, as
  // scripts/dev.sh sets IMP_BROKER_TEST_UPSTREAMS
  readonly dataDir: string;
}

// Removes what the prefixes name, and what hangs off such an imp; a fixture
// image (`e2e-<fixture>-<hash>`) carries no suite prefix, so it stays. A
// removal impd refuses rejects the reset.
export async function resetBaseline(options: Readonly<ResetBaselineOptions>): Promise<void> {
  const client = options.client;

  const [imps, networks, secrets, oauthClients, tokens, images] = await Promise.all([
    client.imps.list(),
    client.networks.list(),
    client.secrets.list(),
    client.oauth.clients.list(),
    client.tokens.list(),
    client.images.list(),
  ]);

  const listOwned = (rows: readonly Readonly<{ name: string }>[]) =>
    rows
      .map((row) => row.name)
      .filter((name) => options.prefixes.some((prefix) => name.startsWith(prefix)));

  // an imp first: it holds its checkpoints, leases, networks, grants and image
  for (const name of listOwned(imps)) {
    await client.imps.destroy({ name });
  }

  for (const name of listOwned(networks)) {
    await client.networks.delete({ name });
  }

  // revokes it from every imp
  for (const name of listOwned(secrets)) {
    await client.secrets.delete({ name });
  }

  // revokes every grant it holds
  for (const name of listOwned(oauthClients)) {
    await client.oauth.clients.delete({ name });
  }

  for (const name of listOwned(tokens)) {
    await client.tokens.delete({ name });
  }

  // a template is an image too
  for (const name of listOwned(images)) {
    await client.images.delete({ name });
  }

  await rm(join(options.dataDir, 'broker-test-upstreams.json'), { force: true });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'NOT_FOUND'
  );
}

// A journey's own release of an imp it made, deferred where the journey
// makes it: one the journey removed itself is no error, and any other
// refusal fails the journey.
export async function removeImpIfPresent(client: ImpClient, name: string): Promise<void> {
  try {
    await client.imps.destroy({ name });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

// The same for an image or template a journey made; release it after the
// imps that boot it.
export async function removeImageIfPresent(client: ImpClient, name: string): Promise<void> {
  try {
    await client.images.delete({ name });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}
