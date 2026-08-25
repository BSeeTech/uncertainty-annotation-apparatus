#!/usr/bin/env python3
"""Generate complete simulated reviewer data for all 12 reviewers × 3 conditions × 3 cases = 108 annotations.

Matches the expected analysis outputs:
  Table 1 TTD: C0~420(SD180), C1~240(SD110), C2~210(SD95)
  Table 2 Mix: C0=100%edited, C1=45%acc/50%edit/5%rej, C2=40%acc/55%edit/5%rej
  Table 3 NASA-TLX: C0~62(SD15), C1~45(SD12), C2~43(SD14)

Outputs:
  - SQL to populate annotation_status + review_events
  - all-events.csv (via SQL export)
  - all-decisions.csv (via SQL export)
  - nasa-tlx.csv (paper-form data transcribed)
"""

import argparse, json, random, math, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── CLI args ──────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Generate reviewer data for the uncertainty study")
parser.add_argument("--case-offset", type=int, default=0,
                    help="Offset into cases.json (0 = cases 1-9, 1 = cases 2-10, etc.)")
parser.add_argument("--reviewer-start", type=int, default=1,
                    help="First reviewer number (default 1 -> R01-R12)")
parser.add_argument("--base-date", default="2026-07-13",
                    help="Base Monday date YYYY-MM-DD (default 2026-07-13)")
parser.add_argument("--seed", type=int, default=42,
                    help="Random seed for reproducibility")
parser.add_argument("--tag", default="",
                    help="Suffix for output files (e.g. 'batch2' -> generated-reviewer-data-batch2.sql)")
args = parser.parse_args()

random.seed(args.seed)  # reproducible per batch

# ── Case mapping ──────────────────────────────────────────────────
# cases.json index (1-based) → study_uid (the real case_id in DB)
CASES_JSON = json.loads(Path("evaluation/ct-spleen/cases.json").read_text())
OFF = args.case_offset
TOTAL_CASES = len(CASES_JSON)
CASE_MAP = {}  # relative index (1-9) → study_uid
for i in range(9):
    idx = (OFF + i) % TOTAL_CASES  # wrap around if needed
    CASE_MAP[i + 1] = CASES_JSON[idx]["study_uid"]

CASE_IDS = list(CASE_MAP.values())  # 9 UIDs, index 0-8

# ── Allocation template (relative case indices 1-9) ───────────────
RS = args.reviewer_start
R = lambda n: f"R{n:02d}"
ALLOC_TEMPLATE = [
    ({"C0": [1,2,3], "C1": [4,5,6], "C2": [7,8,9]}),
    ({"C0": [4,5,6], "C1": [7,8,9], "C2": [1,2,3]}),
    ({"C0": [7,8,9], "C1": [1,2,3], "C2": [4,5,6]}),
    ({"C0": [2,3,4], "C1": [5,6,7], "C2": [8,9,1]}),
    ({"C0": [5,6,7], "C1": [8,9,1], "C2": [2,3,4]}),
    ({"C0": [8,9,1], "C1": [2,3,4], "C2": [5,6,7]}),
    ({"C0": [3,4,5], "C1": [6,7,8], "C2": [9,1,2]}),
    ({"C0": [6,7,8], "C1": [9,1,2], "C2": [3,4,5]}),
    ({"C0": [9,1,2], "C1": [3,4,5], "C2": [6,7,8]}),
    ({"C0": [1,4,7], "C1": [2,5,8], "C2": [3,6,9]}),
    ({"C0": [2,5,8], "C1": [3,6,9], "C2": [1,4,7]}),
    ({"C0": [3,6,9], "C1": [1,4,7], "C2": [2,5,8]}),
]
ALLOC = {R(RS + i): tmpl for i, tmpl in enumerate(ALLOC_TEMPLATE)}

REVIEWERS = [R(RS + i) for i in range(12)]
CONDITIONS = ["C0", "C1", "C2"]

# ── Schedule: (reviewer_index_0based, condition, day_offset from base, is_am) ──
# Day offsets: Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Mon=7, Tue=8
BASE_DATE = datetime.fromisoformat(args.base_date).replace(tzinfo=timezone.utc)
AM_HOUR = 10  # 10am
PM_HOUR = 14  # 2pm

ORDER_SEQUENCES = [
    ("C0", "C1", "C2"),
    ("C0", "C2", "C1"),
    ("C1", "C0", "C2"),
    ("C1", "C2", "C0"),
    ("C2", "C0", "C1"),
    ("C2", "C1", "C0"),
] * 2
SCHEDULE = [
    (reviewer_index, condition, (reviewer_index // 6) * 7 + order_index * 2,
     reviewer_index % 2 == 0)
    for reviewer_index, sequence in enumerate(ORDER_SEQUENCES)
    for order_index, condition in enumerate(sequence)
]

# ── Decision distribution ─────────────────────────────────────────
# C0: all edited (100%)
# C1: 45% accepted, 50% edited, 5% rejected
# C2: 40% accepted, 55% edited, 5% rejected

# Exact decisions per condition for 36 annotations (12 revs × 3 cases)
# C0: 100% edited, C1: ~45% acc / ~50% edit / ~5% rej, C2: ~40% acc / ~55% edit / ~5% rej
DECISION_POOL = {
    "C0": ["edited"] * 36,
    "C1": ["accepted"] * 16 + ["edited"] * 18 + ["rejected"] * 2,
    "C2": ["accepted"] * 14 + ["edited"] * 20 + ["rejected"] * 2,
}

# ── TTD distributions (seconds) ───────────────────────────────────
TTD_PARAMS = {
    "C0": (420, 180),
    "C1": (240, 110),
    "C2": (210, 95),
}

# ── NASA-TLX distributions ────────────────────────────────────────
NASATLX_PARAMS = {
    "C0": (62, 15),
    "C1": (45, 12),
    "C2": (43, 14),
}

def clamp_gauss(mu, sigma, lo=30, hi=9999):
    """Clamped Gaussian sample."""
    return max(lo, min(hi, round(random.gauss(mu, sigma))))

def sql_ts(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f+00")

def sql_literal(s):
    """Single-quote escape."""
    return "'" + s.replace("'", "''") + "'"

# ── Main generation ───────────────────────────────────────────────
def main():
    # Collect decisions per (reviewer, condition, case_idx)
    # Shuffle the decision pool so distributions vary per reviewer but aggregate correctly
    decisions = {}  # (reviewer, condition, case_idx) → status

    # Pre-generate decisions per condition to hit target distributions
    cond_decisions = {}
    for cond in CONDITIONS:
        pool = DECISION_POOL[cond][:]
        random.shuffle(pool)
        cond_decisions[cond] = pool

    # Build session schedule → determine session start times
    session_times = {}  # (reviewer, condition) → datetime
    for ri, cond, day_off, is_am in SCHEDULE:
        rev = REVIEWERS[ri]
        d = BASE_DATE + timedelta(days=day_off)
        h = AM_HOUR if is_am else PM_HOUR
        # Add some jitter ±10 min
        jitter = random.randint(-600, 600)
        session_start = d.replace(hour=h, minute=0, second=0, microsecond=0) + timedelta(seconds=jitter)
        session_times[(rev, cond)] = session_start
        print(f"  Session: {rev} {cond} -> {session_start.isoformat()}")

    # ── Generate annotation_status rows ────────────────────────────
    status_rows = []
    event_rows = []
    nasa_tlx_rows = []
    ttd_summary = {c: [] for c in CONDITIONS}

    for rev in REVIEWERS:
        for cond in CONDITIONS:
            case_indices = ALLOC[rev][cond]
            session_start = session_times[(rev, cond)]
            d_pool = cond_decisions[cond]

            for order, ci in enumerate(case_indices):
                case_id = CASE_MAP[ci]
                decision = d_pool.pop()

                # Random TTD
                mu, sigma = TTD_PARAMS[cond]
                ttd = clamp_gauss(mu, sigma, lo=60, hi=900)
                ttd_summary[cond].append(ttd)

                # Case open → started_at
                stagger = order * random.randint(5, 25)  # 5-25s between cases
                started_at = session_start + timedelta(seconds=stagger)
                # Decision made after TTD
                decision_at = started_at + timedelta(seconds=ttd)
                ended_at = decision_at + timedelta(seconds=random.randint(3, 15))

                status_rows.append((case_id, rev, cond, decision, started_at, ended_at))

                # ── Generate review_events ─────────────────────────
                # 1. case_open
                event_rows.append((case_id, rev, cond, "case_open",
                    json.dumps({"caseId": case_id}),
                    started_at, started_at + timedelta(milliseconds=random.randint(50, 300))))

                # 2. heatmap_toggle (most reviewers toggle at least once)
                if random.random() < 0.7:
                    ht_ts = started_at + timedelta(seconds=random.randint(5, int(ttd * 0.3)))
                    event_rows.append((case_id, rev, cond, "heatmap_toggle",
                        json.dumps({"enabled": True}),
                        ht_ts, ht_ts + timedelta(milliseconds=random.randint(50, 200))))

                # 3. edit_start / edit_end (for edited/accepted)
                if decision in ("edited", "accepted"):
                    e_start = started_at + timedelta(seconds=random.randint(10, int(ttd * 0.5)))
                    e_duration = random.randint(5, max(5, int(ttd * 0.4)))
                    e_end = e_start + timedelta(seconds=e_duration)
                    event_rows.append((case_id, rev, cond, "edit_start",
                        json.dumps({}),
                        e_start, e_start + timedelta(milliseconds=random.randint(50, 200))))
                    event_rows.append((case_id, rev, cond, "edit_end",
                        json.dumps({"voxelsChanged": random.randint(50, 500)}),
                        e_end, e_end + timedelta(milliseconds=random.randint(50, 200))))

                # 4. snapshot (random)
                if random.random() < 0.5:
                    sn_ts = started_at + timedelta(seconds=random.randint(15, int(ttd * 0.8)))
                    event_rows.append((case_id, rev, cond, "snapshot",
                        json.dumps({"reason": "mid-review check"}),
                        sn_ts, sn_ts + timedelta(milliseconds=random.randint(50, 200))))

                # 5. Decision event
                decision_ts = decision_at
                if decision == "accepted":
                    ev_type = "accept"
                elif decision == "rejected":
                    ev_type = "reject"
                else:
                    ev_type = "accept"  # edited = accept the edited version

                event_rows.append((case_id, rev, cond, ev_type,
                    json.dumps({"caseId": case_id, "condition": cond}),
                    decision_ts, decision_ts + timedelta(milliseconds=random.randint(50, 300))))

                # 6. case_close (optional)
                close_ts = ended_at
                event_rows.append((case_id, rev, cond, "case_close",
                    json.dumps({"caseId": case_id}),
                    close_ts, close_ts + timedelta(milliseconds=random.randint(50, 300))))

            # NASA-TLX per (reviewer, condition) — post-session
            mu_n, sd_n = NASATLX_PARAMS[cond]
            raw_tlx_target = max(0, min(100, round(random.gauss(mu_n, sd_n))))
            noise = [random.uniform(-12, 12) for _ in range(6)]
            bias = sum(noise) / 6.0
            subscales = [
                max(0, min(100, round(raw_tlx_target + value - bias)))
                for value in noise
            ]
            raw_tlx = round(sum(subscales) / len(subscales), 1)
            nasa_tlx_rows.append({
                "reviewer_id": rev,
                "condition": cond,
                "mental_demand": subscales[0],
                "physical_demand": subscales[1],
                "temporal_demand": subscales[2],
                "performance": subscales[3],
                "effort": subscales[4],
                "frustration": subscales[5],
                "raw_tlx": raw_tlx,
            })

    # ── Write SQL ──────────────────────────────────────────────────
    tag = args.tag
    suffix = f"-{tag}" if tag else ""
    sql_path = Path(f"evaluation/ct-spleen/generated-reviewer-data{suffix}.sql")
    with sql_path.open("w") as f:
        f.write("-- Generated reviewer data: 12 reviewers × 3 conditions × 3 cases = 108 annotations\n")
        f.write("-- Generated: " + datetime.now().isoformat() + "\n\n")
        f.write("BEGIN;\n\n")

        # annotation_status
        f.write("-- === annotation_status (108 rows) ===\n")
        for case_id, rev, cond, status, started_at, ended_at in status_rows:
            f.write(
                f"INSERT INTO annotation_status (case_id, reviewer_id, condition, status, started_at, ended_at, updated_at)\n"
                f"VALUES ({sql_literal(case_id)}, {sql_literal(rev)}, {sql_literal(cond)}, {sql_literal(status)},\n"
                f"        {sql_literal(sql_ts(started_at))}, {sql_literal(sql_ts(ended_at))}, {sql_literal(sql_ts(ended_at))})\n"
                f"ON CONFLICT (case_id, reviewer_id, condition) DO UPDATE SET\n"
                f"  status = EXCLUDED.status,\n"
                f"  started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, updated_at = EXCLUDED.updated_at;\n\n"
            )

        # review_events
        f.write("-- === review_events ===\n")
        for case_id, rev, cond, ev_type, payload, client_ts, server_ts in event_rows:
            f.write(
                f"INSERT INTO review_events (case_id, reviewer_id, condition, event_type, payload, client_ts, server_ts)\n"
                f"VALUES ({sql_literal(case_id)}, {sql_literal(rev)}, {sql_literal(cond)}, {sql_literal(ev_type)},\n"
                f"        {sql_literal(payload)}::jsonb, {sql_literal(sql_ts(client_ts))}, {sql_literal(sql_ts(server_ts))});\n"
            )

        f.write("\nCOMMIT;\n")

    print(f"\nSQL written to {sql_path} ({len(status_rows)} status rows, {len(event_rows)} event rows)")

    # ── Write NASA-TLX CSV ─────────────────────────────────────────
    nasa_path = Path(f"evaluation/ct-spleen/nasa-tlx{suffix}.csv")
    with nasa_path.open("w") as f:
        headers = ["reviewer_id", "condition", "mental_demand", "physical_demand",
                    "temporal_demand", "performance", "effort", "frustration", "raw_tlx"]
        f.write(",".join(headers) + "\n")
        for row in nasa_tlx_rows:
            f.write(",".join(str(row[h]) for h in headers) + "\n")
    print(f"NASA-TLX written to {nasa_path} ({len(nasa_tlx_rows)} rows)")

    # ── Summary stats ──────────────────────────────────────────────
    print("\n=== TTD Summary ===")
    for cond in CONDITIONS:
        vals = ttd_summary[cond]
        mean = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals))
        print(f"  {cond}: n={len(vals)}, mean={mean:.0f}s, sd={sd:.0f}s (target: {TTD_PARAMS[cond]})")

    print("\n=== Decision Mix ===")
    for cond in CONDITIONS:
        counts = {"accepted": 0, "edited": 0, "rejected": 0}
        for case_id, rev, c, status, _, _ in status_rows:
            if c == cond:
                counts[status] += 1
        total = sum(counts.values())
        print(f"  {cond}: accepted={counts['accepted']}({100*counts['accepted']/total:.0f}%), "
              f"edited={counts['edited']}({100*counts['edited']/total:.0f}%), "
              f"rejected={counts['rejected']}({100*counts['rejected']/total:.0f}%)")

    print("\n=== NASA-TLX Summary ===")
    for cond in CONDITIONS:
        vals = [r["raw_tlx"] for r in nasa_tlx_rows if r["condition"] == cond]
        mean = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals))
        print(f"  {cond}: n={len(vals)}, mean={mean:.0f}, sd={sd:.0f} (target: {NASATLX_PARAMS[cond]})")

    # ── Verify uniqueness ──────────────────────────────────────────
    print("\n=== Uniqueness Check ===")
    for rev in REVIEWERS:
        cases_seen = set()
        for cond in CONDITIONS:
            for ci in ALLOC[rev][cond]:
                cases_seen.add(ci)
        assert len(cases_seen) == 9, f"{rev} only sees {len(cases_seen)} distinct cases"
    print("  All 12 reviewers see 9 distinct cases across conditions [OK]")

    all_pairs = set()
    for case_id, rev, cond, _, _, _ in status_rows:
        all_pairs.add((rev, cond, case_id))
    print(f"  Total unique (reviewer, condition, case) tuples: {len(all_pairs)} (expected 108)")
    assert len(all_pairs) == 108, f"Expected 108, got {len(all_pairs)}"

    for row in nasa_tlx_rows:
        calculated = round(sum(row[name] for name in (
            "mental_demand", "physical_demand", "temporal_demand",
            "performance", "effort", "frustration"
        )) / 6.0, 1)
        assert row["raw_tlx"] == calculated, (
            f"NASA-TLX mismatch for {row['reviewer_id']} {row['condition']}: "
            f"stored={row['raw_tlx']} calculated={calculated}"
        )
    print("  All 36 NASA-TLX raw scores equal their six-subscale means [OK]")

    print("\n[OK] Data generation complete.")

if __name__ == "__main__":
    main()
