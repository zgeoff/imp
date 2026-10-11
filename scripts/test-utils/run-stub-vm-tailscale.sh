#!/bin/bash
# Stands in for the tailscale CLI in deploy/nixos/tests/vm.nix's stub image,
# which runs it as `tailscale` with STUB_TAILSCALE_DIR set to the state dir.
# The saved state says "valid" (Running), "starting" (Starting) or anything
# else (NeedsLogin); `up` reads the key file, logs its arguments and makes the
# state valid. A key file holding used-key is a single-use key that joined
# once already, refused as tailscale refuses it.
dir=${STUB_TAILSCALE_DIR:?}
up='' key_file='' name=''
for arg in "$@"; do
  case $arg in
    up) up=1 ;;
    --auth-key=file:*) key_file=${arg#--auth-key=file:} ;;
    --hostname=*) name=${arg#--hostname=} ;;
  esac
done
if [ -n "$up" ]; then
  [ -s "$key_file" ] || {
    echo "fake tailscale: no key in $key_file" >&2
    exit 1
  }
  if [ "$(cat "$key_file")" = used-key ]; then
    echo "backend error: invalid key: unable to validate API key" >&2
    exit 1
  fi
  echo "up $*" >>"$dir/fake-up.log"
  echo valid >"$dir/tailscaled.state"
  echo "$name" >"$dir/fake-hostname"
  exit 0
fi
case $(cat "$dir/tailscaled.state" 2>/dev/null) in
  valid) state=Running ;;
  starting) state=Starting ;; # no network yet
  *) state=NeedsLogin ;;
esac
name=$(cat "$dir/fake-hostname" 2>/dev/null || echo none)
printf '{"BackendState":"%s","Self":{"HostName":"%s","TailscaleIPs":["100.64.0.1"],"DNSName":"%s.example.ts.net."}}\n' \
  "$state" "$name" "$name"
