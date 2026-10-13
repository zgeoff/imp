#!/bin/sh
# The `gh` that createStubGhAttestation puts on PATH, for an install script's
# provenance check. Beside it, gh.calls gets each call's arguments, and
# gh.auth-status and gh.attestation hold the exit codes of `auth status` and
# of `attestation ...`; every other command succeeds. Builtins only, since the
# script under test may run with a PATH of a few linked commands.
dir=${0%/*}
echo "$*" >>"$dir/gh.calls"

if [ "$1 $2" = "auth status" ]; then
  read -r code <"$dir/gh.auth-status"
  exit "$code"
fi

if [ "$1" = attestation ]; then
  read -r code <"$dir/gh.attestation"
  exit "$code"
fi

exit 0
