#!/bin/bash
# Print the Homebrew formula for one released version, with each platform's
# checksum read from the release's SHA256SUMS. The release workflow commits
# it to the tap (RELEASING.md); `brew install zgeoff/tap/imp` then installs
# the binary and its shell completions.
#
#   scripts/build-formula.sh <version> <path to SHA256SUMS>
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <version> <SHA256SUMS>" >&2
  exit 2
fi

version=$1
sums=$2

if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "build-formula: $version is not X.Y.Z" >&2
  exit 2
fi

# a formula without a checksum would install whatever the URL serves
sha() {
  local sum
  sum=$(awk -v name="imp-$1" '$2 == name { print $1 }' "$sums")
  if ! [[ $sum =~ ^[0-9a-f]{64}$ ]]; then
    echo "build-formula: no sha256 for imp-$1 in $sums" >&2
    exit 1
  fi
  echo "$sum"
}

base="https://github.com/zgeoff/imp/releases/download/v$version"
darwin_arm64=$(sha darwin-arm64)
darwin_x64=$(sha darwin-x64)
linux_arm64=$(sha linux-arm64)
linux_x64=$(sha linux-x64)

cat <<FORMULA
class Imp < Formula
  desc "CLI for impd: persistent Linux microVMs that sleep when idle"
  homepage "https://github.com/zgeoff/imp"
  version "$version"
  license "MIT"

  on_macos do
    on_arm do
      url "$base/imp-darwin-arm64"
      sha256 "$darwin_arm64"
    end
    on_intel do
      url "$base/imp-darwin-x64"
      sha256 "$darwin_x64"
    end
  end

  on_linux do
    on_arm do
      url "$base/imp-linux-arm64"
      sha256 "$linux_arm64"
    end
    on_intel do
      url "$base/imp-linux-x64"
      sha256 "$linux_x64"
    end
  end

  def install
    # a bare download may arrive without +x, and the completions below run
    # the binary before Homebrew fixes modes
    binary = Dir["imp-*"].first
    chmod 0755, binary
    bin.install binary => "imp"
    generate_completions_from_executable(bin/"imp", "completion")
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/imp --version").strip
  end
end
FORMULA
