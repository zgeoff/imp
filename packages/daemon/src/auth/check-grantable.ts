import { SecretNameSchema } from '@imp/api';
import type { ReadSecretGeneration, Refusal } from './access-policy';
import { formatCaller } from './caller';
import type { Caller } from './caller';

// The secret must be on the caller's list, and the secret by that name now
// must be the one it was given. A missing secret reads as a stale entry, so
// the refusal is the same whether it exists or not.
export async function checkGrantable(
  caller: Readonly<Caller>,
  secret: string | null,
  readSecretGeneration: ReadSecretGeneration,
): Promise<Refusal | null> {
  const entry = secret === null ? undefined : caller.grantable.find((each) => each.name === secret);
  const current = entry === undefined ? null : await readSecretGeneration(entry.name);

  if (entry !== undefined && current === entry.generation) {
    return null;
  }

  // the input is not checked yet: it is named only when it has a name's form
  const named = SecretNameSchema.safeParse(secret);
  const what = named.success ? `secret ${named.data}` : 'that secret';

  return {
    message: `${formatCaller(caller)} may not grant or revoke ${what}`,
    reason: 'not_grantable',
  };
}
