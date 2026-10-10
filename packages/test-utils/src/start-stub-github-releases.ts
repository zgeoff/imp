import { onTestFinished } from 'bun:test';

interface StubGithubReleasesOptions {
  // the tag /latest redirects to, or null for a repo with no release, whose
  // /latest GitHub sends back to the releases page
  readonly latest: string | null;

  // each asset's body by `<tag>/<file>`, served under /download/
  readonly assets: Readonly<Record<string, string>>;
}

export interface StubGithubReleases {
  // what IMP_RELEASES_URL takes in place of github.com/<owner>/<repo>/releases
  readonly url: string;

  // the path of each request, in order
  readonly requests: readonly string[];
}

// A repo's releases pages on loopback, for a script that fetches with curl:
// /latest redirects to /tag/<tag>, a tag's page answers, and each asset sits
// under /download/<tag>/<file>. Anything else is a 404. Stopped at test end.
export function startStubGithubReleases(options: StubGithubReleasesOptions): StubGithubReleases {
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;

      requests.push(path);

      if (path === '/latest') {
        const location = options.latest === null ? '/' : `/tag/${options.latest}`;

        return Response.redirect(location, 302);
      }

      if (path.startsWith('/tag/') || path === '/') {
        return new Response('release page');
      }

      const asset = path.startsWith('/download/')
        ? options.assets[path.slice('/download/'.length)]
        : undefined;

      return asset === undefined ? new Response('Not Found', { status: 404 }) : new Response(asset);
    },
  });

  onTestFinished(() => server.stop(true));

  return { url: `http://127.0.0.1:${String(server.port)}`, requests };
}
