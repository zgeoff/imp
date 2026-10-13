#!/bin/sh
# The `shasum` that createStubShasum puts on PATH: macOS's `shasum -a 256
# <file>`, answered by the sha256sum whose full path shasum.sha256sum beside
# it holds. shasum.calls gets each call's arguments. Builtins only, since the
# script under test runs with a PATH that lacks sha256sum.
dir=${0%/*}
echo "$*" >>"$dir/shasum.calls"
[ "$1 $2" = "-a 256" ] || exit 1
read -r sha256sum <"$dir/shasum.sha256sum"
exec "$sha256sum" "$3"
