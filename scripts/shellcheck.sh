#!/bin/bash
# Run shellcheck over every tracked shell file under scripts/, host/ and test/.
# A file counts as shell when it ends in .sh, starts with a shell shebang
# (scripts/imp, host/entrypoint), or carries a `# shellcheck shell=` directive
# (sourced libraries such as scripts/lib.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

# TEMPORARY: the e2e harness rework (#3) deletes these files. They are skipped
# here so CI is green whichever branch merges first; the second to merge
# removes this list.
excluded=(
  scripts/acceptance.sh
  scripts/acceptance/fc-pss.sh
  scripts/acceptance/lib.sh
  scripts/build-rootfs.sh
  scripts/e2e-checkpoints.sh
  scripts/e2e-lifecycle.sh
  scripts/e2e-runtime.sh
  scripts/proto-sleep.sh
  scripts/smoke-boot.sh
  scripts/smoke-docker.sh
)

is_excluded() {
  local path
  for path in "${excluded[@]}"; do
    [[ $1 == "$path" ]] && return 0
  done
  return 1
}

is_shell() {
  [[ $1 == *.sh ]] && return 0
  head -n 1 "$1" | grep -qE '^#!.*[/ ](ba|da|k)?sh( .*)?$' && return 0
  grep -q '^# shellcheck shell=' "$1"
}

files=()
while IFS= read -r file; do
  is_excluded "$file" && continue
  is_shell "$file" && files+=("$file")
done < <(git ls-files scripts host test)

# -x follows `source` lines, so lib.sh functions resolve in their callers
shellcheck -x "${files[@]}"
