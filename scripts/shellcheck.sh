#!/bin/bash
# Run shellcheck over every tracked shell file under scripts/, host/ and test/.
# A file counts as shell when it ends in .sh, starts with a shell shebang
# (scripts/imp, host/entrypoint), or carries a `# shellcheck shell=` directive
# (sourced libraries such as scripts/lib.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

is_shell() {
  [[ $1 == *.sh ]] && return 0
  head -n 1 "$1" | grep -qE '^#!.*[/ ](ba|da|k)?sh( .*)?$' && return 0
  grep -q '^# shellcheck shell=' "$1"
}

files=()
while IFS= read -r file; do
  is_shell "$file" && files+=("$file")
done < <(git ls-files scripts host test)

# -x follows `source` lines, so lib.sh functions resolve in their callers
shellcheck -x "${files[@]}"
