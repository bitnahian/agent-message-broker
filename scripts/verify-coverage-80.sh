#!/usr/bin/env bash
# Final monitor-rerunnable verification for the coverage-80 goal.
# Usage (from repo root):  bash scripts/verify-coverage-80.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=========== per-package vitest coverage (Stmts / Branch / Funcs / Lines) ==========="
FAIL=0
for p in server cli adapter-pi adapter-claude adapter-codex ui; do
  line=$(npx vitest run --root "packages/$p" --coverage 2>/dev/null | grep "All files" | head -1 || true)
  printf "%-16s %s\n" "$p:" "$line"
  # extract Stmts (col 2) and Branch (col 3), drop non-numeric chars
  stmts=$(echo "$line" | awk -F'|' '{gsub(/[^0-9.]/,"",$2); print $2}')
  branch=$(echo "$line" | awk -F'|' '{gsub(/[^0-9.]/,"",$3); print $3}')
  # compare numerically (both are float); >=80 required
  ok=$(awk -v s="$stmts" -v b="$branch" 'BEGIN{print (s+0>=80 && b+0>=80)?1:0}')
  if [ "$ok" = "1" ]; then
    echo "  -> PASS (stmts=$stmts% branch=$branch%)"
  else
    echo "  -> BELOW 80 (stmts=$stmts% branch=$branch%)"
    FAIL=1
  fi
done
echo
echo "core: pure types-only package (interfaces/type keywords only, no runtime statements) —"
echo "      not instrumentable by v8; exempt from the numeric coverage target."
echo
echo "========== full build ==========="
npm run build 2>&1 | tail -1
echo
echo "========== full test suite ==========="
npm run test 2>&1 | grep -E "Successfully ran target test|failed|Tests " | tail -3
echo
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT: ALL PACKAGES >= 80% STATEMENTS AND BRANCHES"
else
  echo "RESULT: SOME PACKAGES BELOW 80%"
fi
exit "$FAIL"