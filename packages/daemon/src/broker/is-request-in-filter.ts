import type { GrantFilter } from '@impz/api';

// An encoded slash or backslash, which an upstream may decode into a
// segment break after the filter matched the path as one segment
const ENCODED_SEPARATOR = /%2f|%5c/i;

// True when a grant's filter lets the request have the credential. The path
// is the URL parser's pathname, which the broker sends upstream, so it holds
// no dot segments; patterns match it as GrantFilterSchema describes.
export function isRequestInFilter(filter: GrantFilter, method: string, path: string): boolean {
  if (filter.methods !== undefined && !filter.methods.includes(method)) {
    return false;
  }

  if (filter.paths === undefined) {
    return true;
  }

  if (ENCODED_SEPARATOR.test(path)) {
    return false;
  }

  const segments = path.split('/');

  return filter.paths.some((pattern) => isPathMatch(pattern.split('/'), segments));
}

// both start with the empty segment before the first slash
function isPathMatch(pattern: readonly string[], segments: readonly string[]): boolean {
  const isRest = pattern.at(-1) === '**';
  const fixed = isRest ? pattern.slice(0, -1) : pattern;

  if (isRest ? segments.length < fixed.length : segments.length !== fixed.length) {
    return false;
  }

  return fixed.every((part, index) => {
    const segment = segments[index];

    return part === '*' ? segment !== undefined && segment !== '' : part === segment;
  });
}
