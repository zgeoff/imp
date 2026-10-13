interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;

  // each commit's full message, oldest first
  readonly commits: readonly string[];
}

// Whether release-please reads the squash merge of the pull request as
// breaking: docs/runbooks/releasing.md#breaking-changes.
export function isMarkedBreaking(pr: Readonly<PullRequest>): boolean {
  const message = findOverride(pr.body) ?? buildSquashMessage(pr);
  const [header = ''] = message.split('\n');

  return (
    /^\w+(?:\([^)]*\))?!:/u.test(header) ||
    /^BREAKING CHANGE:[^\S\n]*\S/mu.test(message) ||
    /BREAKING-CHANGE:\s*\S/u.test(message)
  );
}

function findOverride(body: string): string | undefined {
  const [, afterBegin = ''] = body.split('BEGIN_COMMIT_OVERRIDE');
  const [override = ''] = afterBegin.split('END_COMMIT_OVERRIDE');
  const trimmed = override.trim();

  return trimmed === '' ? undefined : trimmed;
}

function buildSquashMessage(pr: Readonly<PullRequest>): string {
  const [only, ...rest] = pr.commits;

  if (only !== undefined && rest.length === 0) {
    return only;
  }

  const body = pr.commits.map((message) => `* ${message.trim()}`).join('\n\n');

  return `${pr.title} (#${String(pr.number)})\n\n${body}`;
}
