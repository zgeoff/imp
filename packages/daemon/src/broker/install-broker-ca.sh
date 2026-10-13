#!/bin/sh
# Builds the guest's CA bundle at <target>: the guest's own roots (CAs it
# added included), then the broker CA. Stdin holds the broker CA, a line that
# is <roots-marker>, then the host's roots, which go in only when no
# <root-path> holds a bundle. A <target> that already holds this bundle stays
# as it is, so a wake does not write to the disk.
#
# Plain POSIX sh: it runs as root in any guest image, which may lack Bun and
# awk. impd runs it as `sh -c "$script" install-broker-ca <arg>...`, so every
# path reaches it as an argument and none is spliced into the script.
#
# Usage: install-broker-ca.sh <target> <roots-marker> <root-path>...
set -e

target=$1
marker=$2
shift 2

input=$target.in
next=$target.tmp

mkdir -p "$(dirname "$target")"
cat >"$input"

# the first line that is the marker, matched whole and as a fixed string
split=$(grep -n -x -F -e "$marker" "$input" | head -n 1 | cut -d : -f 1)

if [ -z "$split" ]; then
  rm -f "$input"
  echo "install-broker-ca: stdin has no '$marker' line" >&2
  exit 1
fi

roots=
for f in "$@"; do
  if [ -s "$f" ]; then
    roots=$f
    break
  fi
done

{
  if [ -n "$roots" ]; then
    cat "$roots"
  else
    tail -n "+$((split + 1))" "$input"
  fi
  echo
  head -n "$((split - 1))" "$input"
} >"$next"

rm -f "$input"

if [ -f "$target" ] && [ "$(cat "$next")" = "$(cat "$target")" ]; then
  rm -f "$next"
else
  mv "$next" "$target"
fi
