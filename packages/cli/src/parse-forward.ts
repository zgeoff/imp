import { UsageError } from './usage-error';

// One `imp proxy` port: `5432` listens on 5432 and reaches 5432 in the imp;
// `15432:5432` listens on 15432. A local 0 takes any free port.
export interface Forward {
  readonly local: number;
  readonly remote: number;
}

const MAX_PORT = 65_535;

export function parseForward(spec: string): Forward {
  const match = /^(?:(?<local>\d+):)?(?<remote>\d+)$/.exec(spec);
  const remote = Number(match?.groups?.['remote']);
  const localText = match?.groups?.['local'];
  const local = localText === undefined ? remote : Number(localText);

  if (match === null || remote < 1 || remote > MAX_PORT || local > MAX_PORT) {
    throw new UsageError(`not a port: ${spec} (try 5432, or local:remote such as 15432:5432)`);
  }

  return { local, remote };
}
