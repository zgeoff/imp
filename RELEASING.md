# Releasing

Releases come from `main` through [release-please](https://github.com/googleapis/release-please)
(manifest mode, one package at the root) and two workflows: the `release-please` job in
`.github/workflows/ci.yml`, and `.github/workflows/release.yml`. The changelog starts at
`bootstrap-sha` in `release-please-config.json`, the `main` commit before release-please arrived.

## What a release ships

| Where                                          | What                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ghcr.io/zgeoff/imp-host:X.Y.Z` and `:latest`  | The host image (`host/build-release.sh`), linux/amd64, with a provenance attestation. |
| GitHub release `vX.Y.Z`: `imp-<os>-<arch>`     | The CLI for `linux-x64`, `linux-arm64`, `darwin-x64` and `darwin-arm64`.              |
| GitHub release `vX.Y.Z`: `vmlinux`             | The guest kernel, x86_64.                                                             |
| GitHub release `vX.Y.Z`: `imp-system.squashfs` | The system drive with the guest agent, x86_64.                                        |
| GitHub release `vX.Y.Z`: `SHA256SUMS`          | The sha256 of every asset above, with a provenance attestation per asset.             |
| npm: `@zgeoff/imp-client@X.Y.Z`                | The client library, with npm provenance, once [npm](#npm) is turned on.               |

The image, `impd --version`, `imp --version` and every `package.json` carry the same version: the
tag without the `v`. The host image, the kernel and the drive are x86_64 only, because Firecracker
in the image and the guest kernel config are.

Check an asset or the image:

```sh
sha256sum -c SHA256SUMS
gh attestation verify imp-linux-x64 -R zgeoff/imp
gh attestation verify oci://ghcr.io/zgeoff/imp-host:X.Y.Z -R zgeoff/imp
```

## Flow

1. A `feat:` or `fix:` commit lands on `main`. After the gates pass, the `release-please` job opens
   or updates the release PR: the version bump in every `package.json`, `CHANGELOG.md` and
   `.release-please-manifest.json`. It then syncs `bun.lock` (which records the workspace versions)
   and the formatting on the PR branch. Before 1.0, a `feat:` bumps the minor version and a `fix:`
   the patch.
2. The release PR merges (see [Tokens](#tokens) for who merges it).
3. On that merge, `release-please` tags `vX.Y.Z`, creates the GitHub release, and starts
   `release.yml` for the tag (`gh workflow run release.yml --ref main -f tag=vX.Y.Z`). The release
   is a run of its own, so it never holds up CI on `main`. Its jobs:
   - **assets:** checks out the tag and runs `scripts/build-release-assets.sh`.
   - **smoke:** runs each CLI binary on its own platform and checks its checksum and version.
   - **image:** after every smoke check passes, runs `host/build-release.sh` and
     `host/check-release-image.sh`, which fails when `impd` or `imp` in the image reports another
     version, or when the image's kernel or drive differs from `SHA256SUMS`. Then it pushes
     `imp-host:X.Y.Z` and attests the image and every asset.
   - **publish:** uploads the assets to the release, then moves `latest` to `X.Y.Z` when `vX.Y.Z` is
     the newest release.
   - **npm-pack** and **npm-publish:** after publish, npm-pack packs `@zgeoff/imp-client`, checks
     the tarball and uploads it; npm-publish, the only job with the OIDC token, publishes it. npm's
     `latest` moves only when `vX.Y.Z` is the newest release; an older one goes out under
     `previous`. Both are skipped until [npm](#npm) is turned on, and for a version npm already has.

The kernel layer stays in the GitHub Actions cache, so the image job and later releases reuse it.
Without that cache, the kernel build takes about 15 to 25 minutes on a hosted runner. A second run
for the same tag waits for the first.

## Tokens

Releases need a GitHub App. `GITHUB_TOKEN` events start no workflows, so a release PR opened with it
would get no CI run. Until the App is configured, the `release-please` job is skipped, as in atc,
and no release PR opens.

With the App, the job opens the release PR with the App's token, CI runs on it, and the job turns on
auto-merge (`gh pr merge --auto --squash`). With `.github/rulesets/main.json` applied, GitHub merges
the PR once its required checks pass; without it, at once. To set it up:

1. Create a GitHub App (or reuse `zgeoff-release`) with no webhook, and give it Contents and Pull
   requests read and write. Install it on `zgeoff/imp`.
2. Add the Actions variable `RELEASE_APP_ID` (the App's client ID) and the Actions secret
   `RELEASE_APP_PRIVATE_KEY` (its private key).
3. Turn on Settings → General → "Allow auto-merge".

The release itself starts with `GITHUB_TOKEN`: a workflow dispatch is the one `GITHUB_TOKEN` event
that starts a workflow.

The first push creates the `imp-host` package on GHCR as private. Make it public once in the package
settings, so a server pulls it without a login.

## npm

`@zgeoff/imp-client` (`packages/client`) is the one npm package. It carries the release's version,
so a client and an impd of the same version speak the same API. The bundled `@imp/api` stays
private. `scripts/pack-client.sh` builds it and packs the tarball into `build/npm/`, with `exports`
on `dist/` only; in the workspace, `exports` points at `src/`, so nothing in the repo needs a build.
`scripts/check-client-package.sh <tarball>` installs it into an empty project, imports it under
plain Node and type-checks the README's examples. The `client` CI job runs both on every change.

npm trusted publishing can only be set up for a package that exists, so the first publish is by
hand:

```sh
npm login
scripts/first-publish-client.sh
```

The script publishes the current version, then prints the last two steps: add the trusted publisher
on npmjs.com (repository `zgeoff/imp`, workflow `release.yml`), and set the Actions variable
`NPM_PUBLISH_ENABLED` to `true`. From then on the release's `npm` job publishes each version with
OIDC and provenance, and no npm token lives in CI.

## Dry run

Run the release workflow with no tag:

```sh
gh workflow run release.yml
```

It builds and checks everything for the current `main` as a release would, pushes
`ghcr.io/zgeoff/imp-host:dryrun-<sha>` and attests it and the assets, and leaves the assets as the
`release-assets` workflow artifact. It uploads nothing to a release and leaves `latest` alone. The
version it checks is the one in `package.json`. Delete old `dryrun-` tags in the package settings.

Locally, with no push:

```sh
scripts/build-release-assets.sh                                   # dist/ and dist/SHA256SUMS
IMP_VERSION=$(jq -r .version package.json) host/build-release.sh
host/check-release-image.sh "imp-host:$(jq -r .version package.json)" "$(jq -r .version package.json)" dist/SHA256SUMS
```

`bun run build:cli` builds only the CLI binaries, in `dist/`. Pass target names to narrow the set:
`scripts/build-cli.sh linux-x64`.

## Republish

When a release was tagged but its build or publish failed, fix the cause on `main` if it is in the
workflow, then run the release workflow for the tag:

```sh
gh workflow run release.yml -f tag=vX.Y.Z
```

It builds the tag's sources, not `main`'s. It replaces the release assets (`--clobber`) and the
`X.Y.Z` image tag, moves `latest` only when `vX.Y.Z` is the newest release, and publishes the client
when npm does not have that version yet. A fix to the sources needs a new release, not a republish.
