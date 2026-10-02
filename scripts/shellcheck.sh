#!/bin/bash
# Run shellcheck over every tracked shell file under scripts/, host/, kernel/,
# deploy/ and test/.
# A file counts as shell when it ends in .sh, starts with a shell shebang
# (scripts/imp, host/entrypoint), or carries a `# shellcheck shell=` directive
# (sourced libraries such as scripts/lib.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

# moby's contrib/check-config.sh, kept as upstream wrote it
vendored=(kernel/check-config.sh)

is_excluded() {
  local path
  for path in "${vendored[@]}"; do
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
done < <(git ls-files scripts host kernel test deploy)

# -x follows `source` lines, so lib.sh functions resolve in their callers
shellcheck -x "${files[@]}"
