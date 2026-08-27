#!/usr/bin/env bash
# Monitor-rerunnable verification: the Playwright e2e suite must exercise
# packages/ui/src with >= 80% statement AND branch coverage (measured via the
# instrumented browser bundle).
#
# Run from the repo root:  bash scripts/verify-e2e-coverage.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RAW=/tmp/amb-e2e-raw-coverage.json
COV="packages/ui/e2e-coverage/coverage-final.json"
rm -f "$RAW"

echo "== running the full Playwright e2e suite (instrumented UI) =="
# shellcheck disable=SC2155
export RAW_FILE_OUT=""
npx playwright test --config packages/ui/playwright.config.ts 2>&1 | tail -15

echo
echo "== e2e coverage report (packages/ui/src, via instrumented browser) =="
python3 - "$COV" <<'PYEOF'
import json, sys

cov = json.load(open(sys.argv[1]))

def counters(c):
    sm = c["statementMap"]; s = c["s"]
    st_tot = len(sm); st_hit = sum(1 for k in s if s[k] > 0)
    bm = c.get("branchMap", {}); b = c.get("b", {})
    br_tot = br_hit = 0
    for k in bm:
        br_tot += len(bm[k].get("locations", []))
        cnts = b.get(k, [])
        br_hit += sum(1 for n in range(len(bm[k].get("locations", []))) if n < len(cnts) and cnts[n])
    fm = c.get("fnMap", {}); f = c.get("f", {})
    fn_tot = len(fm); fn_hit = sum(1 for k in f if f[k] > 0)
    return st_tot, st_hit, br_tot, br_hit, fn_tot, fn_hit

st_t = st_h = br_t = br_h = fn_t = fn_h = 0
for fname, c in cov.items():
    a, b_, cc, d, e, g = counters(c)
    st_t += a; st_h += b_; br_t += cc; br_h += d; fn_t += e; fn_h += g
    name = fname.split("/")[-1]
    sp = (100 * b_ / a) if a else 0
    bp = (100 * d / cc) if cc else 0
    print(f"  {name:22s} stmts {b_}/{a} ({sp:.1f}%)   branch {d}/{cc} ({bp:.1f}%)")

pct = lambda h, t: (100 * h / t) if t else 0
st_pct = pct(st_h, st_t); br_pct = pct(br_h, br_t)
print("-------------------------------------------------------------")
print(f"TOTAL  stmts {st_h}/{st_t} ({st_pct:.1f}%)  branch {br_h}/{br_t} ({br_pct:.1f}%)  funcs {fn_h}/{fn_t} ({pct(fn_h, fn_t):.1f}%)")
if st_pct >= 80.0 and br_pct >= 80.0:
    print(f"RESULT: PASS (stmts {st_pct:.1f}%  branch {br_pct:.1f}%, both >= 80%)")
    sys.exit(0)
print(f"RESULT: FAIL (stmts {st_pct:.1f}%  branch {br_pct:.1f}%, need both >= 80%)")
sys.exit(1)
PYEOF