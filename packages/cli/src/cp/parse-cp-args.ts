import { NameSchema } from '@imp/api';
import { UsageError } from '../usage-error';

// `imp cp ./dir box:/srv/dir` uploads; `imp cp box:/var/log/x .` downloads.
// A side is in an imp when it reads NAME:PATH with a valid imp name; a local
// path with a colon in its first part starts with ./ instead.
export interface CpPlan {
  readonly direction: 'upload' | 'download';
  readonly name: string;
  readonly guestPath: string;
  readonly localPath: string;
}

interface GuestSide {
  readonly name: string;
  readonly path: string;
}

function parseGuestSide(spec: string): GuestSide | null {
  const colon = spec.indexOf(':');

  if (colon <= 0 || spec.slice(0, colon).includes('/')) {
    return null;
  }

  const name = spec.slice(0, colon);
  const path = spec.slice(colon + 1);

  return NameSchema.safeParse(name).success ? { name, path } : null;
}

export function parseCpArgs(source: string, target: string): CpPlan {
  const from = parseGuestSide(source);
  const to = parseGuestSide(target);

  if ((from === null) === (to === null)) {
    throw new UsageError(
      'one side of imp cp is in an imp: imp cp ./dir box:/srv/dir, or imp cp box:/var/log/x .',
    );
  }

  const guest = from ?? to;

  if (guest === null || guest.path === '') {
    throw new UsageError('name a path in the imp: box:/srv/dir, or box:dir in its home');
  }

  return from === null
    ? { direction: 'upload', name: guest.name, guestPath: guest.path, localPath: source }
    : { direction: 'download', name: guest.name, guestPath: guest.path, localPath: target };
}
