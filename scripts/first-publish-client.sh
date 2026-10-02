#!/bin/bash
# Publish @zgeoff/imp-client to npm by hand, once. npm trusted publishing
# can only be set up for a package that exists, so the first version goes out
# from the owner's machine; release.yml publishes every later one.
#
#   npm login && scripts/first-publish-client.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=$(jq -r .name "$root/packages/client/package.json")

npm whoami > /dev/null || {
  echo "not logged in to npm: run npm login" >&2
  exit 1
}

if npm view "$name" version > /dev/null 2>&1; then
  echo "$name is on npm already: releases publish it (RELEASING.md)" >&2
  exit 1
fi

tarball=$("$root/scripts/pack-client.sh")
"$root/scripts/check-client-package.sh" "$tarball"
npm publish "$tarball" --access public

cat << DONE

Published $(basename "$tarball").

Now let release.yml publish the next versions:
  1. On https://www.npmjs.com/package/$name/access, add a trusted publisher:
     GitHub Actions, user zgeoff, repository imp, workflow release.yml, no environment.
  2. Set the Actions variable NPM_PUBLISH_ENABLED to true:
     gh variable set NPM_PUBLISH_ENABLED --body true -R zgeoff/imp
DONE
