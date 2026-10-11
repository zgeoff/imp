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
   scripts/first-publish-client.sh
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
scripts/build-release-assets.sh                                   # dist/ and dist/SHA256SUMS
IMP_VERSION=$(jq -r .version package.json) host/build-release.sh
host/check-release-image.sh "imp-host:$(jq -r .version package.json)" "$(jq -r .version package.json)" dist/SHA256SUMS
```

To check the Homebrew formula by hand:

```sh
scripts/build-formula.sh 1.2.3 dist/SHA256SUMS > /tmp/imp.rb && ruby -c /tmp/imp.rb
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
