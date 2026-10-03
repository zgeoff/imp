#!/bin/bash
# imp-host-dns-token.sh SOURCE DIR: stage the DNS API token for the NixOS
# module (deploy/nixos/module.nix), which runs it before each start of
# imp-host, when SOURCE changes, and every 5 minutes. impd reads the staged
# copy at each DNS call (IMP_DNS_API_TOKEN_FILE), so a new token works
# without a restart.
#
# The container mounts DIR, not the file: a bind-mounted file keeps the
# inode it had at the mount, and a rename here makes a new one. So DIR is
# made only when missing and never removed, or the mount would hold a
# directory nothing writes to any more.
#
# A source that is missing or holds no token never replaces a staged one:
# a secrets manager that drops the file for a moment must not take HTTPS
# down. The token is never printed.
set -euo pipefail
umask 077

source=${1:?usage: imp-host-dns-token.sh SOURCE DIR}
dir=${2:?usage: imp-host-dns-token.sh SOURCE DIR}
staged=$dir/token

[ -d "$dir" ] || mkdir -p "$dir"

# The source is read once, into a copy that every check then looks at: a
# file that a secrets manager swaps or removes between a check and the copy
# cannot slip past. A read that fails keeps the old token and exits 0, so
# the start of imp-host never fails on it.
tmp=$(mktemp "$dir/.token.XXXXXX")
trap 'rm -f "$tmp"' EXIT

if ! cat -- "$source" >"$tmp" 2>/dev/null || ! grep -q '[^[:space:]]' "$tmp"; then
  if grep -q '[^[:space:]]' "$staged" 2>/dev/null; then
    echo "imp-host-dns-token: $source is missing or empty; impd keeps the token staged before" >&2
  else
    echo "imp-host-dns-token: $source is missing or empty; HTTPS certificates and DNS records wait until it holds the token" >&2
  fi
  exit 0
fi

if cmp -s "$tmp" "$staged"; then
  exit 0
fi

# renamed over the old copy: impd reads the old token or the new one,
# never half a file
chmod 0400 "$tmp"
mv -f "$tmp" "$staged"
trap - EXIT
echo "imp-host-dns-token: staged the DNS API token from $source"
