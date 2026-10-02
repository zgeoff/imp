import { statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// where impd serves the dashboard; packages/dashboard builds for this base
export const DASHBOARD_PATH = '/ui/';

// The dashboard's built files. A path with no file is an app route and gets
// the shell; an /assets/ path never does, so a stale chunk 404s instead of
// loading HTML as a script.
export function createDashboardFiles(dir: string | null) {
  const root = dir === null ? null : resolve(dir);

  return {
    serve: (request: Request): Response => {
      if (root === null || !isFile(join(root, 'index.html'))) {
        return new Response('the dashboard is not built into this impd (IMP_DASHBOARD_DIR)\n', {
          status: 404,
        });
      }

      const path = decodePath(new URL(request.url).pathname.slice(DASHBOARD_PATH.length - 1));

      if (path === null) {
        return new Response('bad path\n', { status: 400 });
      }

      const file = resolve(root, `.${path}`);

      // decodePath already refuses `..`; this holds the line if it ever stops
      if (relative(root, file).startsWith('..') || !`${file}${sep}`.startsWith(`${root}${sep}`)) {
        return new Response('bad path\n', { status: 400 });
      }

      if (isFile(file)) {
        return buildFileResponse(file, path.startsWith('/assets/'));
      }

      if (path.startsWith('/assets/')) {
        return new Response('not found\n', { status: 404 });
      }

      return buildFileResponse(join(root, 'index.html'), false);
    },
  };
}

// Vite names every asset by its content hash, so it never changes; the shell
// and anything else must be checked each time, or a new build is not seen
function buildFileResponse(file: string, immutable: boolean): Response {
  const headers: Record<string, string> = {
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };

  if (file.endsWith('.html')) {
    Object.assign(headers, HTML_HEADERS);
  }

  return new Response(Bun.file(file), { headers });
}

// the page talks only to impd; imps' pages on other ports must not frame it
const HTML_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",

    // xterm.js and the UI kit set inline styles
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'referrer-policy': 'same-origin',
};

// the decoded path, or null when it is malformed or climbs out with `..`
function decodePath(pathname: string): string | null {
  try {
    const path = decodeURIComponent(pathname);

    if (path.includes('\0') || path.split(/[/\\]/).includes('..')) {
      return null;
    }

    return path;
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
