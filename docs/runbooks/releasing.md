# Releasing

Releases come from `main` through [release-please](https://github.com/googleapis/release-please) and
two workflows. A `feat:` or `fix:` commit on `main` makes the `release-please` job in CI open or
update the release PR, which bumps every version, the changelog and the lock file. The release PR
merges itself once its checks pass. On that merge the job tags `vX.Y.Z` and starts the release
workflow for the tag, which builds the CLI, the guest kernel, the system drive, the host image, the
base image, the npm client and the Homebrew formula, smoke-tests each, and publishes and attests
them. Every artifact carries the tag's version without the `v`, so a client, an impd and a NixOS
flake pinned to one tag agree. The workflows' own comments cover each job; this runbook holds the
steps they do not do.

## Breaking changes

A client accepts any impd of its own major version, so a change that breaks the protocol between
them must ship as a new major. release-please bumps the major only for a commit marked as breaking,
and the breaking-change workflow fails a pull request whose protocol change breaks a client and
carries no mark.

The protocol lives in `packages/api/protocol-schema.json`: every oRPC procedure's input and output,
the messages of the `/exec`, `/tunnel` and `/images/build` streams, the error codes with their data,
and the wire constants, each as JSON Schema that zod derives from the contract.
`bun run render:protocol` writes the file, and `bun test` fails until it matches the code. The check
compares the file at the pull request's merge base with the file at its head, by these rules:

- What a client sends must still pass: impd must accept every input it accepted before. A new
  required field, a tighter bound, a dropped enum value, or a field impd no longer reads breaks a
  client.
- What impd sends must still make sense to an older client. A field that may now be missing, a
  changed type, a looser bound, or a variant of a tagged union that impd stops sending breaks a
  client. A new field, a new value of an enum, and a new variant of a tagged union do not, because a
  client passes over what it does not know. The union's tag is its discriminator: the property each
  variant fixes to its own value, such as `type`.
- A removed procedure, message, error code or constant, a changed error status, and a procedure that
  changes between one answer and an event stream all break a client.

The check compares the protocol rather than the client's TypeScript declarations because the outcome
to protect is a client that can still talk to impd. A type diff would flag a renamed export that
breaks no request, and it would miss a tighter bound, which a TypeScript type does not show. The
check cannot see a zod refinement, or what a transform in an output returns, because JSON Schema
cannot express either.

To mark a change, put a `!` after the type, as in `feat(#412)!: drop imps.get`, or add a
`BREAKING CHANGE: <what breaks>` footer to a commit message. The repository squash-merges, and
GitHub takes the subject of a pull request with one commit from that commit, so the `!` goes in the
commit's subject there and in the PR title when the pull request has several commits. A
`BEGIN_COMMIT_OVERRIDE` block in the PR body replaces the message release-please reads. Editing the
title or the body runs the check again.

## Set up a repository for releases

These steps are done for `zgeoff/imp`. They are here for a new repository, or to set one up again.

1. **The release App.** Events from `GITHUB_TOKEN` start no workflows, so a release PR opened with
   it would get no CI run, and the `release-please` job is skipped until an App is configured.
   Create a GitHub App, or reuse `zgeoff-release`, with no webhook and with Contents and Pull
   requests read and write. Install it on the repository and on `zgeoff/homebrew-tap`. Add the
   Actions variable `RELEASE_APP_ID` (the App's client ID) and the Actions secret
   `RELEASE_APP_PRIVATE_KEY`, and turn on Settings → General → "Allow auto-merge".
2. **GHCR.** The first push creates the `imp-host` and `imp-base` packages as private. Make each one
   public in its package settings, so a server pulls it without a login, and link `imp-base` to the
   repository.
3. **The Homebrew tap.** Add the Actions variable `HOMEBREW_TAP` = `homebrew-tap`: the repository
   name, not the full slug. Without it, or without the App, the `tap` job is skipped and every other
   job still runs.
4. **npm.** Trusted publishing can only be set up for a package that exists, so a new package's
   first publish is by hand:

   ```sh
   npm login
   scripts/release/first-publish-client.sh
   ```

   The script publishes the current version, then prints the last two steps: add the trusted
   publisher on npmjs.com (workflow `release.yml`), and set the Actions variable
   `NPM_PUBLISH_ENABLED` to `true`. From then on each release publishes with OIDC, and no npm token
   lives in CI.

## Dry run

A run of the release workflow with no tag builds and checks everything for the current `main` as a
release would, and publishes nothing to a release:

```sh
gh workflow run release.yml
```

It pushes `imp-host:dryrun-<sha>` and `imp-base:dryrun-<sha>`, attests them and the assets, and
leaves the assets as the `release-assets` workflow artifact. Delete old `dryrun-` tags in the
package settings. To build without a push:

```sh
scripts/release/build-release-assets.sh                                   # dist/ and dist/SHA256SUMS
IMP_VERSION=$(jq -r .version package.json) scripts/release/build-release.sh
scripts/release/check-release-image.sh "imp-host:$(jq -r .version package.json)" "$(jq -r .version package.json)" dist/SHA256SUMS
```

To check the Homebrew formula by hand:

```sh
scripts/release/build-formula.sh 1.2.3 dist/SHA256SUMS > /tmp/imp.rb && ruby -c /tmp/imp.rb
brew install --formula /tmp/imp.rb && brew test imp     # on a machine with brew
```

## Republish

When a release was tagged but its build or publish failed, fix the cause on `main` if it is in the
workflow, then run the release workflow for the tag:

```sh
gh workflow run release.yml -f tag=vX.Y.Z
```

It builds the tag's sources, not `main`'s, and replaces the release assets and the `imp-host:X.Y.Z`
tag. It publishes `imp-base:X.Y.Z` and the npm client only where they are missing, and moves
`latest` only when the tag is the newest release. A fix to the sources needs a new release, not a
republish.

## An unattested imp-base

A published `imp-base` tag never moves, because consumers pin it by digest. So when `imp-base:X.Y.Z`
exists before the release pushes it, and carries no attestation from this repository, the `base` job
fails with an error that names the tag and its digest. This workflow did not vouch for that image:
someone with a leaked `write:packages` token could have pushed it ahead of the release. Treat it as
a possible compromise and investigate:

```sh
docker buildx imagetools inspect ghcr.io/zgeoff/imp-base:X.Y.Z
gh attestation verify oci://ghcr.io/zgeoff/imp-base:X.Y.Z -R zgeoff/imp
```

The workflow never deletes, re-pushes or attests such a tag. Consumers that pinned an earlier digest
are not affected, and the next release publishes its own tag. Deleting the package version is the
owner's decision. The same holds when a run pushes the image and then fails at its own attest step.
When the verify failed only for a transient reason, such as an API error, a republish passes.
