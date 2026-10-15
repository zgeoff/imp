#!/bin/sh
# Install the impz CLI for this machine from a GitHub release into
# ~/.local/bin (or IMP_INSTALL_DIR). No Bun or Node is needed.
#
#   curl -fsSL https://raw.githubusercontent.com/zgeoff/impz/main/install.sh | sh
#
# Env: IMP_INSTALL_VERSION  a release such as 0.4.0 (default: the latest)
#      IMP_INSTALL_DIR      where the binary goes (default: ~/.local/bin)
#      IMP_RELEASES_URL     the releases page (default: zgeoff/impz's on GitHub)
#
# The binary is checked against the release's SHA256SUMS, and with the gh CLI
# on PATH and logged in, against the release's build provenance too. Nothing
# is installed when a check fails.
set -eu

releases=${IMP_RELEASES_URL:-https://github.com/zgeoff/impz/releases}
dir=${IMP_INSTALL_DIR:-$HOME/.local/bin}

fail() {
  echo "impz: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "no binary for $(uname -s)" ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "no binary for $(uname -m)" ;;
esac

# The tag is resolved once, so the binary and SHA256SUMS come from the same
# release even when a new one is published in between.
if [ -n "${IMP_INSTALL_VERSION:-}" ]; then
  tag=v${IMP_INSTALL_VERSION#v}
else
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest") ||
    fail "cannot reach $releases/latest"
  tag=${latest##*/}
fi

case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "no release found at $releases (got '$tag')" ;;
esac

asset=impz-$os-$arch
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "impz: downloading $asset $tag"
curl -fsSL "$releases/download/$tag/$asset" -o "$tmp/$asset" || fail "cannot download $asset $tag"
curl -fsSL "$releases/download/$tag/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
  fail "cannot download SHA256SUMS for $tag"

want=$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
  got=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
[ -n "$want" ] || fail "SHA256SUMS for $tag lists no $asset"
[ "$got" = "$want" ] || fail "$asset does not match SHA256SUMS for $tag; nothing installed"

# gh asks the GitHub API for the attestation, which needs a login
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh attestation verify "$tmp/$asset" -R zgeoff/impz >/dev/null ||
    fail "could not verify provenance of $asset from zgeoff/impz; nothing installed"
  echo "impz: provenance verified"
elif command -v gh >/dev/null 2>&1; then
  echo "impz: gh is not logged in; skipped the provenance check"
fi

# copied next to the target first, so the rename replaces an old impz in one
# step even when the temp directory is on another filesystem
mkdir -p "$dir"
cp "$tmp/$asset" "$dir/.impz.tmp"
chmod +x "$dir/.impz.tmp"
mv "$dir/.impz.tmp" "$dir/impz"

# on its own line, so set -e stops here when the binary does not run
version=$("$dir/impz" --version)
echo "impz: installed $version to $dir/impz"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "impz: add $dir to your PATH" ;;
esac

# the CLI was named imp before impz; the old binary is left for its owner
if [ -e "$dir/imp" ]; then
  echo "impz: $dir/imp is the CLI from before its rename to impz; remove it once nothing calls it"
fi
