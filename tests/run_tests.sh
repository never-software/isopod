#!/bin/zsh
# tests/run_tests.sh — Run all isopod tests
#
# Usage:
#   ./tests/run_tests.sh                    Run all tests
#   ./tests/run_tests.sh test_help.sh       Run a specific test file
#   TEST_FILTER=routing ./tests/run_tests.sh  Filter tests by name

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ISOPOD_ROOT="$(cd "$TESTS_DIR/.." && pwd)"

# Colors
_BOLD='\033[1m'
_CYAN='\033[0;36m'
_GREEN='\033[0;32m'
_RED='\033[0;31m'
_NC='\033[0m'

printf "\n${_BOLD}${_CYAN}isopod test suite${_NC}\n"
printf "${_CYAN}%s${_NC}\n" "$(printf '%.0s─' {1..40})"

TOTAL_EXIT=0

# Determine which test files to run
if [[ $# -gt 0 ]]; then
  test_files=()
  for arg in "$@"; do
    if [[ "$arg" == *.sh ]]; then
      test_files+=("$TESTS_DIR/$arg")
    else
      test_files+=("$TESTS_DIR/${arg}.sh")
    fi
  done
else
  test_files=("$TESTS_DIR"/test_*.sh)
fi

for test_file in "${test_files[@]}"; do
  [[ -f "$test_file" ]] || continue
  [[ "$(basename "$test_file")" == "test_helper.sh" ]] && continue

  (
    cd "$ISOPOD_ROOT"
    source "$test_file"
  )
  [[ $? -ne 0 ]] && TOTAL_EXIT=1
done

echo ""
printf "${_CYAN}%s${_NC}\n" "$(printf '%.0s─' {1..40})"
if [[ $TOTAL_EXIT -eq 0 ]]; then
  printf "${_GREEN}${_BOLD}All test files passed.${_NC}\n\n"
else
  printf "${_RED}${_BOLD}Some tests failed.${_NC}\n\n"
fi

exit $TOTAL_EXIT
