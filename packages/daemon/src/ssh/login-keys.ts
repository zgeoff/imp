import type { Caller } from '../auth/caller';
import type { BoundSshKey } from '../auth/token-store';
import { formatKeyFingerprint } from './authorized-keys';
import type { AuthorizedKey, AuthorizedKeys } from './authorized-keys';

// A key a client offers, and who a login with it runs as.
interface LoginKey {
  readonly key: AuthorizedKey;
  readonly caller: Caller;

  // the binding's id, so removing it ends the login; null for a file key
  readonly keyId: string | null;
}

export interface LoginKeys {
  readonly findKey: (blob: Buffer) => LoginKey | null;
}

interface LoginKeysDeps {
  readonly findBound: (blob: Buffer) => BoundSshKey | null;

  // null when IMP_SSH_AUTHORIZED_KEYS=false
  readonly file: AuthorizedKeys | null;
}

// A key bound to a token wins over the same key in authorized_keys: the
// narrower grant holds even if someone adds the key to the file later.
export function createLoginKeys(deps: Readonly<LoginKeysDeps>): LoginKeys {
  return {
    findKey: (blob) => {
      const bound = deps.findBound(blob);

      if (bound !== null) {
        return { key: bound.key, caller: bound.caller, keyId: bound.keyId };
      }

      const key = deps.file?.findKey(blob) ?? null;

      return key === null ? null : { key, caller: buildFileCaller(key), keyId: null };
    },
  };
}

// A file key has every imp. It is named `key <comment>`: a token name has
// no space, so the audit log never mixes the two up.
function buildFileCaller(key: Readonly<AuthorizedKey>): Caller {
  const display = key.comment === '' ? key.type : key.comment;

  return {
    kind: 'ssh',
    name: `key ${display}`,
    scope: 'manage',
    imps: null,
    grantable: [],
    tokenId: null,
    expiresAt: null,
    principal: `key:${formatKeyFingerprint(key.blob)}`,
    display,
  };
}
