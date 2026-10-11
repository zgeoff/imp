# Agent Guidelines

imp gives you small Linux computers that stay yours: each one is a Firecracker microVM with real
root, its own kernel and Docker inside. `docs/architecture/overview.md` explains how the pieces fit,
and `docs/runbooks/development.md` holds the checks, the end-to-end harness, worktree dev instances,
the hooks, and CI.

## Required reading

The rules a task needs are not repeated here. Load the skill for the work before starting it.

| Skill             | Load before                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `code-style`      | writing, reviewing, or renaming any TypeScript — the function-verb taxonomy and imp's verbs |
| `testing`         | designing, writing, or reviewing tests                                                      |
| `project-testing` | the same, beside `testing` — imp's own test facts                                           |
| `docs-writing`    | writing or editing any committed prose: `docs/`, READMEs, this file, skills                 |

## Operations

- Perform all work on a branch in a git worktree under `.worktrees/` (e.g.
  `git worktree add .worktrees/<branch> -b <branch>`) — never commit directly on `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages.
- A squash merge makes the PR title the commit subject, so a PR title is a Conventional Commit too.
  `feat(#412): add the retry budget` is a title; `add the retry budget` is not.
- Commit subjects and PR titles use the imperative mood ("add X", never "added X" or a bare noun
  phrase).
- Open PRs against `main`. Descriptions are condensed: lead paragraph ≤2 sentences, one-line
  bullets, ≤150 words — write the short version first, don't draft long and trim.
- After pushing, link the PR URL in your response.
- A PR is ready only when its checks are green: watch CI (`gh pr checks <n> --watch`) after opening
  or updating, and report a failure with what you're doing about it.
- Light linting, formatting, and other checks run via lefthook's pre-commit and pre-push hooks.
  Defer to CI for larger checks, as the environment you're operating in may have conservative memory
  constraints.
- `bun run lint` is plain oxlint. `bun run lint:full` adds the type-aware pass and the type check,
  and is CI-only: never run it locally.

## Dependencies

- Pin exact versions — no `^`/`~` ranges. (`bun add` saves exact automatically via `exact = true` in
  bunfig.toml — the rule applies to hand-written edits.) The 7-day `minimumReleaseAge` gate in
  bunfig.toml applies.

## Review bots

CodeRabbit reviews every PR with the shared config in the zgeoff/coderabbit repo, and reads this
file as its guidelines. A review bot added later is named here with its config, and these rules
cover it too.

- A PR is ready only after every bot review is read and every finding is answered: a fixed finding's
  reply cites the commit that fixed it; a declined finding's reply states the reason — when a
  finding contradicts this file, this file wins and the reply names the rule. Reviews land within a
  few minutes of opening; read them with `gh pr view <n> --comments` and
  `gh api repos/<owner>/<repo>/pulls/<n>/comments`. A finding outside the diff arrives in the review
  body, not as a thread, so its answer is a PR comment.
- Resolve a thread once its reply is posted, fixed and declined alike (GraphQL
  `resolveReviewThread`). A finding the agent cannot confidently judge is escalation, not
  disposition: reply saying so and leave the thread open for a human.
- Never teach a bot through chat (`@coderabbitai` learnings and the like) — a correction to bot
  behaviour is an edit to its config, reviewed in a PR.
- Bots review a PR once, at open; an agent invokes a re-review only when asked. The exception is a
  PR that got no review at all, such as one opened before the bot was installed: request it once
  with that bot's documented trigger, such as `@coderabbitai review` for CodeRabbit.
