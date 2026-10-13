#!/bin/bash
# Run shellcheck and shfmt over install.sh and every tracked shell file under
# scripts/, host/, kernel/, deploy/, test/ and packages/.
# A file counts as shell when it ends in .sh, starts with a shell shebang
# (scripts/imp, host/entrypoint), or carries a `# shellcheck shell=` directive
# (sourced libraries such as scripts/lib.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."

# moby's contrib/check-config.sh, kept as upstream wrote it
vendored=(kernel/check-config.sh)

# deploy/bootstrap.sh's parts share its variables, so each is checked within
# the whole: deploy/bootstrap.sh, which scripts/render/render-imp-host.ts writes
parts=deploy/bootstrap/

is_excluded() {
  [[ $1 == "$parts"* ]]
}

is_shell() {
  [[ $1 == *.sh ]] && return 0
  head -n 1 "$1" | grep -qE '^#!.*[/ ](ba|da|k)?sh( .*)?$' && return 0
  grep -q '^# shellcheck shell=' "$1"
}

is_vendored() {
  local path
  for path in "${vendored[@]}"; do
    [[ $1 == "$path" ]] && return 0
  done
  return 1
}

files=()
formatted=()
while IFS= read -r file; do
  is_vendored "$file" && continue
  is_shell "$file" || continue
  formatted+=("$file")
  is_excluded "$file" || files+=("$file")
done < <(git ls-files install.sh scripts host kernel test deploy packages)

# -x follows `source` lines, so lib.sh functions resolve in their callers
shellcheck -x "${files[@]}"

# the parts of deploy/bootstrap.sh are formatted too, so the whole renders
# formatted; lefthook's pre-commit runs `shfmt -w` with these flags
shfmt -d -i 2 -ci "${formatted[@]}"
