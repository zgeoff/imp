#!/bin/bash
# Run the agent's Go tests with the race detector through the gotestsum
# version that agent/go.mod pins as a tool, keep the JSON event stream for
# timing comparisons, and print the slowest cases.
#
#   scripts/test-go.sh [go test flags]
#
# GO_TEST_JSONFILE picks where the JSON results land (default: a new file
# under TMPDIR for each run). Extra arguments go to `go test` after -race, such as -count=1.
# The script exits with the test run's status, after printing the slowest
# cases whether the run passed or failed.
set -euo pipefail
cd "$(dirname "$0")/../agent"

if [ -n "${GO_TEST_JSONFILE:-}" ]; then
  jsonfile=$GO_TEST_JSONFILE
  mkdir -p "$(dirname "$jsonfile")"
else
  jsonfile=$(mktemp "${TMPDIR:-/tmp}/imp-go-test.XXXXXX.json")
fi

status=0
go tool gotestsum --format testname --jsonfile "$jsonfile" -- -race "$@" ./... || status=$?

# A run that dies before writing any results (a build error, say) has no
# timings to show; its own exit status is the one that matters.
if [ -s "$jsonfile" ]; then
  echo
  echo "test-go: JSON results in $jsonfile"
  echo "test-go: slowest cases (over 500ms):"
  go tool gotestsum tool slowest --jsonfile "$jsonfile" --threshold 500ms || true
fi

exit "$status"
