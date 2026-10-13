import { getLogger } from '@logtape/logtape';
import type { Logger } from '@logtape/logtape';

// impd's logger for one area, category ["impd", area]; impd's own with no
// area. A line about one imp names it in the `imp` property, through
// logger.with({ imp }) or withImpLogContext.
export function getImpdLogger(area?: string): Logger {
  const category = area === undefined ? ['impd'] : ['impd', area];

  return getLogger(category);
}
