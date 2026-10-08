#!/bin/bash
# The imp end-to-end harness: every suite drives impd in the dev container
# through the CLI, the way a user would. The suites live in test/e2e.
#
#   scripts/test-e2e.sh [--only SUITES | --group N] [--clean | --reuse] [--keep]
#
# --group N runs one of the fast set's CI groups (test/e2e/lib/suites.ts
# FAST_GROUPS), as each of CI's e2e runners does.
#
# scripts/test-e2e.sh --help lists the suites, sets and tuning env.
set -euo pipefail
exec bun "$(dirname "$0")/../test/e2e/main.ts" "$@"
