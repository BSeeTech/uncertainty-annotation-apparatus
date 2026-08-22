#!/usr/bin/env bash
# scripts/precompute-all.sh
#
# Pre-computes all inferences for every case × condition combination
# so the reviewer Docker profile can serve them without a live MONAI
# Label GPU backend.
#
# Usage:
#   ./scripts/precompute-all.sh [--cases /path/to/cases.json] [--output /path/to/artifacts]
#
# Requires: docker compose (main stack) running with MONAI Label + PostgreSQL.
# Produces: one .zip per (case, condition) in the output directory.
#           Also writes case-allocation.json for the automated allocation script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CASES_JSON="${1:-$PROJECT_ROOT/evaluation/ct-spleen/cases.json}"
OUTPUT_DIR="${2:-/tmp/reviewer-artifacts}"
ALLOCATION_FILE="$OUTPUT_DIR/case-allocation.json"
UNCERTAINTY_URL="${UNCERTAINTY_URL:-http://localhost:58050}"
CONDITIONS=("C0" "C1" "C2" "C3" "C4" "C5")

mkdir -p "$OUTPUT_DIR"

echo "=== Pre-computing inferences for all cases × conditions ==="
echo "Cases: $CASES_JSON"
echo "Output: $OUTPUT_DIR"
echo ""

# Read cases
if [ ! -f "$CASES_JSON" ]; then
  echo "ERROR: Cases file not found: $CASES_JSON"
  exit 1
fi

CASE_IDS=$(python3 -c "
import json
with open('$CASES_JSON') as f:
    cases = json.load(f)
for c in cases:
    print(c.get('case_id') or c['study_uid'])
")

TOTAL=0
for case_id in $CASE_IDS; do
  for cond in "${CONDITIONS[@]}"; do
    # C0 has no inference (manual-only)
    if [ "$cond" == "C0" ]; then
      echo "  [$cond] $case_id — SKIP (manual baseline)"
      continue
    fi

    OUT_FILE="$OUTPUT_DIR/${case_id}_${cond}.zip"
    if [ -f "$OUT_FILE" ]; then
      echo "  [$cond] $case_id — already exists, skipping"
      continue
    fi

    echo "  [$cond] $case_id — inferring..."
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$UNCERTAINTY_URL/infer/$case_id" \
      -H "Content-Type: application/json" \
      -d "{\"condition\": \"$cond\"}" 2>/dev/null || echo "000")

    if [ "$STATUS" = "200" ]; then
      echo "    → done (HTTP 200)"
    elif [ "$STATUS" = "000" ]; then
      echo "    → ERROR: cannot reach uncertainty service at $UNCERTAINTY_URL"
      exit 1
    else
      echo "    → WARNING: HTTP $STATUS (check logs)"
    fi
    TOTAL=$((TOTAL + 1))
  done
done

echo ""
echo "=== Copying artifacts to output directory ==="
# The uncertainty service stores artifacts at UNCERTAINTY_OUTPUT_DIR
# Docker volume path.  We need to copy from there.
ARTIFACT_SRC="${ARTIFACT_SRC:-/var/lib/uncertainty-service/outputs}"
if [ -d "$ARTIFACT_SRC" ]; then
  cp "$ARTIFACT_SRC"/*.zip "$OUTPUT_DIR/" 2>/dev/null || true
  echo "Copied $(ls "$OUTPUT_DIR"/*.zip 2>/dev/null | wc -l) artifacts"
fi

echo ""
echo "=== Generating case allocation ==="
cat > "$ALLOCATION_FILE" <<PYEOF
import json, random, itertools

random.seed(42)

with open("$CASES_JSON") as f:
    cases = json.load(f)

case_ids = [c["case_id"] for c in cases]
conditions = ["C0", "C1", "C2", "C3", "C4", "C5"]

# Latin-square style: each condition appears first for 1/6 of reviewers
allocation = []
for i, reviewer_id in enumerate(["R%02d" % j for j in range(1, 51)]):
    cond_order = conditions[i % len(conditions):] + conditions[:i % len(conditions)]
    # Assign 6 cases per reviewer (one per condition), no repeats
    assigned = set()
    slots = []
    random.shuffle(case_ids)
    pool = iter(case_ids)
    for cond in cond_order:
        for cid in pool:
            if cid not in assigned:
                assigned.add(cid)
                slots.append({"case_id": cid, "condition": cond})
                break
    allocation.append({
        "reviewer_id": reviewer_id,
        "slots": slots
    })

with open("$ALLOCATION_FILE", "w") as f:
    json.dump({"allocations": allocation, "seed": 42}, f, indent=2)
print(f"Allocated {len(allocation)} reviewers")

# Also produce a human-readable summary
total_slots = sum(len(a["slots"]) for a in allocation)
print(f"Total case×condition slots: {total_slots}")
print(f"Unique reviewers: {len(allocation)}")
PYEOF
python3 "$ALLOCATION_FILE"

echo ""
echo "=== Done ==="
echo "Artifacts:  $OUTPUT_DIR/  ($(ls "$OUTPUT_DIR"/*.zip 2>/dev/null | wc -l) files)"
echo "Allocation: $ALLOCATION_FILE"
echo ""
echo "To deploy for a reviewer:"
echo "  docker compose --profile reviewer up -d"
echo "  # Then point reviewer to http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2"
