import { getConfig } from '@logtape/logtape';
import type { LogLevel } from '@logtape/logtape';
import { getImpdLogger } from './get-impd-logger';

// The words after "impd: " that name an area of impd, as the older lines
// start: "impd: broker: …". Any other first word followed by a colon names
// an imp: "impd: <imp>: asleep in …".
const AREAS = new Set([
  'api',
  'audit',
  'backup',
  'boot',
  'broker',
  'cgroup',
  'credential',
  'disk',
  'egress',
  'events',
  'gc',
  'governor',
  'https',
  'idle',
  'image',
  'ipv6',
  'jail',
  'memory',
  'move',
  'oauth',
  'proxy',
  'public',
  'rpc',
  'session',
  'ssh',
  'stop',
  'storage',
  'tailnet',
  'warning',
  'xfs',
  'zfs',
]);

// what a line about one imp's lifecycle goes under
const IMP_AREA = 'imps';

interface LegacyLine {
  readonly area: string | undefined;
  readonly imp: string | undefined;
  readonly level: LogLevel;
}

// An "impd: <area or imp>: <text>" line sent through LogTape with its text
// kept and its area, imp and level read from it; the adapter while call
// sites move to getImpdLogger.
export function printLog(message: string): void {
  // a process that never ran setupLogging, such as a script
  if (getConfig() === null) {
    console.log(message);

    return;
  }

  const line = parseLegacyLine(message);
  const logger = getImpdLogger(line.area);

  // the text as one value, so braces in it are never read as placeholders
  (line.imp === undefined ? logger : logger.with({ imp: line.imp }))[line.level]('{line}', {
    line: message,
  });
}

// The area, imp and level of an older line. The level: error for a line
// that says ERROR or NO FIREWALL, warning for one that says WARNING,
// warning:, failed, could not, cannot or refused, info otherwise.
export function parseLegacyLine(message: string): LegacyLine {
  const head = /^impd: (?<word>[\w.\-]+)(?<colon>:?)/v.exec(message)?.groups;
  const word = head?.['word'];

  return {
    ...pickAreaAndImp(word, head?.['colon'] === ':'),
    level: pickLevel(message),
  };
}

function pickAreaAndImp(
  word: string | undefined,
  hasColon: boolean,
): Pick<LegacyLine, 'area' | 'imp'> {
  if (word === undefined) {
    return { area: undefined, imp: undefined };
  }

  if (AREAS.has(word)) {
    return { area: word, imp: undefined };
  }

  return hasColon ? { area: IMP_AREA, imp: word } : { area: undefined, imp: undefined };
}

function pickLevel(message: string): LogLevel {
  if (/\bERROR\b|\bNO FIREWALL\b/v.test(message)) {
    return 'error';
  }

  if (/\bWARNING\b|\bwarning:|\bfailed\b|\bcould not\b|\bcannot\b|\brefused\b/v.test(message)) {
    return 'warning';
  }

  return 'info';
}
