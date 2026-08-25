#!/usr/bin/env python3
"""Generate SYNTHETIC R01-R12 data (no human participants) filling the immutable schema.

All rows are simulated fixtures for pipeline testing — no human subjects,
no real consent, no real ethics approvals. The values are calibrated to
match the expected analysis outputs.

Tables populated:
  participants       — 12 synthetic development rows (no consent or ethics claims)
  study_sessions     — 36 rows (condition_order counterbalanced)
  study_attempts     — 108 rows (queue_rank, active_time_ms, heatmap tracking)
  nasa_tlx_responses — 36 rows (six subscales → computed raw_tlx)
  sus_responses      — 0 rows (not administered per study plan)
  segmentation_metrics — 108 rows (null metrics for now; computed post-export)

Matching expected analysis outputs:
  TTD: C0~420(SD180), C1~240(SD110), C2~210(SD95)
  Decision mix: C0=100%edited, C1=44%acc/50%edit/6%rej, C2=39%acc/56%edit/6%rej
  NASA-TLX raw: C0~62(SD15), C1~45(SD12), C2~43(SD14)
"""

import argparse, json, random, math
from datetime import datetime, timedelta, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--base-date", default="2026-07-13")
parser.add_argument("--output-dir", default="evaluation/ct-spleen")
parser.add_argument("--case-offset", type=int, default=0,
                    help="Offset into cases.json (0=cases 1-9, 1=cases 2-10, wraps)")
parser.add_argument("--reviewer-start", type=int, default=1,
                    help="First reviewer number (default 1 -> R01-R12)")
parser.add_argument("--tag", default="",
                    help="Suffix for output files (e.g. 'batch2')")
args = parser.parse_args()

random.seed(args.seed)
OUT = Path(args.output_dir)
BASE_DATE = datetime.fromisoformat(args.base_date).replace(tzinfo=timezone.utc)

# ── Case mapping ──────────────────────────────────────────────────
CASES_JSON = json.loads(Path("evaluation/ct-spleen/cases.json").read_text())
R = lambda n: f"R{n:02d}"
RS = args.reviewer_start
OFF = args.case_offset
TOTAL_CASES = len(CASES_JSON)
CASE_MAP = {}
for i in range(9):
    idx = (OFF + i) % TOTAL_CASES  # wrap around
    CASE_MAP[i + 1] = CASES_JSON[idx]["study_uid"]

# ── Allocation (from document: R01-R04 shown, rest rotated) ──────
ALLOC = [
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
ALLOC = {R(RS + i): a for i, a in enumerate(ALLOC)}
CONDITIONS = ["C0", "C1", "C2"]

# ── Condition order (balanced six-sequence crossover) ─────────────
CONDITION_ORDER = {}
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

# Determine condition_order: 1=first session for that reviewer, 2=second, 3=third
# For same-day sessions, use AM/PM to break ties (AM before PM)
rev_cond_day = {}
rev_cond_is_am = {}
for ri, cond, day, is_am in SCHEDULE:
    rev_cond_day[(ri, cond)] = day
    rev_cond_is_am[(ri, cond)] = is_am
for i in range(12):
    rev = R(RS + i)
    sessions = [(rev_cond_day[(i, c)], not rev_cond_is_am[(i, c)], c) for c in CONDITIONS]
    sessions.sort()
    for order, (day, _, cond) in enumerate(sessions, 1):
        CONDITION_ORDER[(rev, cond)] = order

# ── Session times ─────────────────────────────────────────────────
AM, PM = 10, 14
session_times = {}
for ri, cond, day_off, is_am in SCHEDULE:
    rev = R(RS + ri)
    d = BASE_DATE + timedelta(days=day_off)
    h = AM if is_am else PM
    jitter = random.randint(-300, 300)
    session_times[(rev, cond)] = d.replace(hour=h, minute=0, second=0, microsecond=0) + timedelta(seconds=jitter)

# ── Decision pools ────────────────────────────────────────────────
DECISION_POOL = {
    "C0": ["edited"] * 36,
    "C1": ["accepted"] * 16 + ["edited"] * 18 + ["rejected"] * 2,
    "C2": ["accepted"] * 14 + ["edited"] * 20 + ["rejected"] * 2,
}
TTD_PARAMS = {"C0": (420,180), "C1": (240,110), "C2": (210,95)}
NASATLX_PARAMS = {"C0": (62,15), "C1": (45,12), "C2": (43,14)}

def clamp_gauss(mu, sigma, lo=30, hi=900):
    return max(lo, min(hi, round(random.gauss(mu, sigma))))

def sql_ts(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f+00")

def sql_literal(s):
    return "'" + s.replace("'", "''") + "'"

def sql_nullable(value):
    return "NULL" if value is None else sql_literal(value)

# ── Generate ──────────────────────────────────────────────────────
participant_rows = []
session_rows = []
attempt_rows = []
nasa_rows = []
metrics_rows = []

cond_pools = {c: DECISION_POOL[c][:] for c in CONDITIONS}
for c in cond_pools:
    random.shuffle(cond_pools[c])

ttd_summary = {c: [] for c in CONDITIONS}
nasa_summary = {c: [] for c in CONDITIONS}
REVIEWERS = [R(RS + i) for i in range(12)]

for rev in REVIEWERS:
    # ── Participant ──
    expertise = random.choice(["med_student","med_student","med_student","resident","phd_student","lab_mate"])
    years = round(random.uniform(0.5, 5.0), 1) if expertise != "lab_mate" else round(random.uniform(0, 2.0), 1)
    participant_rows.append((rev, expertise, years, False, False, None, None))

    for cond in CONDITIONS:
        case_indices = ALLOC[rev][cond]
        s_start = session_times[(rev, cond)]
        c_order = CONDITION_ORDER[(rev, cond)]
        s_end = s_start + timedelta(minutes=random.randint(15, 22))
        session_id = f"{rev}-{cond}"

        session_rows.append((session_id, rev, cond, c_order, s_start, s_start, s_end))

        # ── NASA-TLX (six subscales) ──
        # Generate target raw_tlx, then derive 6 subscales that average to it
        mu_n, sd_n = NASATLX_PARAMS[cond]
        raw_tlx_target = max(0, min(100, round(random.gauss(mu_n, sd_n))))
        # 6 perturbations that sum to ~0, centered on target
        noise = [random.uniform(-12, 12) for _ in range(6)]
        bias = sum(noise) / 6.0
        md = max(0, min(100, round(raw_tlx_target + noise[0] - bias)))
        pd = max(0, min(100, round(raw_tlx_target + noise[1] - bias)))
        td = max(0, min(100, round(raw_tlx_target + noise[2] - bias)))
        pf = max(0, min(100, round(raw_tlx_target + noise[3] - bias)))
        ef = max(0, min(100, round(raw_tlx_target + noise[4] - bias)))
        fr = max(0, min(100, round(raw_tlx_target + noise[5] - bias)))
        rtlx = round((md + pd + td + pf + ef + fr) / 6.0, 1)
        nasa_rows.append((session_id, md, pd, td, pf, ef, fr))
        nasa_summary[cond].append(rtlx)

        # ── Attempts ──
        for rank, ci in enumerate(case_indices, 1):
            case_id = CASE_MAP[ci]
            decision = cond_pools[cond].pop()

            mu, sigma = TTD_PARAMS[cond]
            ttd = clamp_gauss(mu, sigma, lo=60, hi=900)
            ttd_summary[cond].append(ttd)

            stagger = (rank - 1) * random.randint(5, 25)
            case_open = s_start + timedelta(seconds=stagger)
            decision_at = case_open + timedelta(seconds=ttd)
            completed = decision_at + timedelta(seconds=random.randint(3, 15))

            total_elapsed = int((completed - case_open).total_seconds() * 1000)
            # active_time = ~70-90% of total elapsed (excludes idle gaps)
            active_ratio = random.uniform(0.70, 0.90)
            active_time = int(total_elapsed * active_ratio)

            heatmap_exposed = cond == "C2"
            heatmap_used = heatmap_exposed and random.random() < 0.65

            attempt_rows.append((
                session_id, case_id, rank,
                case_open, decision_at, completed,
                active_time, total_elapsed,
                heatmap_exposed, heatmap_used, decision
            ))

            # ── Segmentation metrics placeholder (populated post mask-export) ──
            # attempt_id will be assigned after INSERT; we'll use a separate pass
            # For now, record that metrics are pending mask export
            uc_score = round(random.uniform(0.05, 0.85), 4) if cond in ("C1","C2") else None
            uc_band = None
            if uc_score is not None:
                if uc_score < 0.3: uc_band = "low"
                elif uc_score < 0.6: uc_band = "medium"
                else: uc_band = "high"

            metrics_rows.append((
                session_id, case_id,  # linked by (session_id, case_id) → attempt_id later
                None, None, None,     # dice, hd95, assd — post mask-export
                None, None, None,     # edit_voxel_count, ai_foreground, reviewer_foreground
                None,                 # edit_burden_pct
                uc_score, uc_band,
                "v2.1-entropy" if cond in ("C1","C2") else None,
                "monai-label-spleen-ct-v0.3.2" if cond in ("C1","C2") else None,
                30 if cond == "C2" else None,
                None,                 # reference_mask_id — from cases.json reference_available
                None,                 # reviewer_mask_storage_url — populated on export
            ))

# ── Write SQL ─────────────────────────────────────────────────────
tag = args.tag
suffix = f"-{tag}" if tag else ""
sql_path = OUT / f"research-data{suffix}.sql"
with sql_path.open("w") as f:
    f.write("-- SYNTHETIC VALIDATION FIXTURE — NOT HUMAN-PARTICIPANT RESEARCH DATA\n")
    f.write(f"-- Generated: {datetime.now().isoformat()}\n")
    f.write("-- Deterministic pipeline test data; consent and ethics fields are intentionally NULL.\n")
    f.write("-- Must not be used as evidence of participant recruitment, ethics approval, or study outcomes.\n\n")
    f.write("BEGIN;\n\n")

    # participants
    f.write("-- === participants (12 rows) ===\n")
    for rev, exp, yrs, elig, consent, consent_date, ethics in participant_rows:
        f.write(
            f"INSERT INTO participants (reviewer_id, expertise_level, expertise_years, "
            f"eligibility_confirmed, consent_obtained, consent_date, ethics_approval_ref, is_development)\n"
            f"VALUES ({sql_literal(rev)}, {sql_literal(exp)}, {yrs}, {elig}, {consent}, "
            f"{sql_nullable(sql_ts(consent_date) if consent_date else None)}, {sql_nullable(ethics)}, true)\n"
            f"ON CONFLICT (reviewer_id) DO NOTHING;\n\n"
        )

    # study_sessions
    f.write("-- === study_sessions (36 rows) ===\n")
    for sid, rev, cond, corder, sched, actual_start, actual_end in session_rows:
        f.write(
            f"INSERT INTO study_sessions (session_id, reviewer_id, condition, condition_order, "
            f"scheduled_at, actual_start, actual_end)\n"
            f"VALUES ({sql_literal(sid)}, {sql_literal(rev)}, {sql_literal(cond)}, {corder}, "
            f"{sql_literal(sql_ts(sched))}, {sql_literal(sql_ts(actual_start))}, {sql_literal(sql_ts(actual_end))})\n"
            f"ON CONFLICT (session_id) DO NOTHING;\n\n"
        )

    # study_attempts
    f.write("-- === study_attempts (108 rows) ===\n")
    for (sid, case_id, rank, case_open, decision_at, completed,
         active_ms, total_ms, hm_exposed, hm_used, decision) in attempt_rows:
        f.write(
            f"INSERT INTO study_attempts (session_id, case_id, queue_rank, "
            f"case_open_at, first_decision_at, completed_at, "
            f"active_time_ms, total_elapsed_ms, "
            f"heatmap_exposed, heatmap_used, decision)\n"
            f"VALUES ({sql_literal(sid)}, {sql_literal(case_id)}, {rank}, "
            f"{sql_literal(sql_ts(case_open))}, {sql_literal(sql_ts(decision_at))}, {sql_literal(sql_ts(completed))}, "
            f"{active_ms}, {total_ms}, {hm_exposed}, {hm_used}, {sql_literal(decision)})\n"
            f"ON CONFLICT (session_id, case_id) DO NOTHING;\n\n"
        )

    # nasa_tlx_responses
    f.write("-- === nasa_tlx_responses (36 rows) ===\n")
    for sid, md, pd, td, pf, ef, fr in nasa_rows:
        f.write(
            f"INSERT INTO nasa_tlx_responses (session_id, mental_demand, physical_demand, "
            f"temporal_demand, performance, effort, frustration)\n"
            f"VALUES ({sql_literal(sid)}, {md}, {pd}, {td}, {pf}, {ef}, {fr})\n"
            f"ON CONFLICT (session_id) DO NOTHING;\n\n"
        )

    # segmentation_metrics — linked via subquery to attempt_id
    f.write("-- === segmentation_metrics (108 rows, linked via attempt_id) ===\n")
    for (sid, case_id, dice, hd95, assd, evc, ai_fg, rev_fg, eb_pct,
         uc_score, uc_band, scoring_ver, calib_ver, mc_samples,
         ref_mask_id, rev_mask_url) in metrics_rows:
        f.write(
            f"INSERT INTO segmentation_metrics (attempt_id, dice, hd95_mm, assd_mm, "
            f"edit_voxel_count, ai_foreground_voxels, reviewer_foreground_voxels, "
            f"edit_burden_pct, uncertainty_score, uncertainty_band, "
            f"scoring_version, calibration_model_version, mc_dropout_samples, "
            f"reference_mask_id, reviewer_mask_storage_url)\n"
            f"SELECT a.attempt_id, "
            f"{'NULL' if dice is None else dice}::real, "
            f"{'NULL' if hd95 is None else hd95}::real, "
            f"{'NULL' if assd is None else assd}::real, "
            f"{'NULL' if evc is None else evc}::integer, "
            f"{'NULL' if ai_fg is None else ai_fg}::integer, "
            f"{'NULL' if rev_fg is None else rev_fg}::integer, "
            f"{'NULL' if eb_pct is None else eb_pct}::real, "
            f"{'NULL' if uc_score is None else uc_score}::real, "
            f"{'NULL' if uc_band is None else sql_literal(uc_band)}::text, "
            f"{'NULL' if scoring_ver is None else sql_literal(scoring_ver)}::text, "
            f"{'NULL' if calib_ver is None else sql_literal(calib_ver)}::text, "
            f"{'NULL' if mc_samples is None else mc_samples}::integer, "
            f"{'NULL' if ref_mask_id is None else sql_literal(ref_mask_id)}::text, "
            f"{'NULL' if rev_mask_url is None else sql_literal(rev_mask_url)}::text\n"
            f"FROM study_attempts a\n"
            f"WHERE a.session_id = {sql_literal(sid)} AND a.case_id = {sql_literal(case_id)}\n"
            f"ON CONFLICT (attempt_id) DO NOTHING;\n\n"
        )

    f.write("COMMIT;\n")

print(f"SQL written to {sql_path}")
print(f"  participants:       {len(participant_rows)} rows")
print(f"  study_sessions:     {len(session_rows)} rows")
print(f"  study_attempts:     {len(attempt_rows)} rows")
print(f"  nasa_tlx_responses: {len(nasa_rows)} rows")
print(f"  segmentation_metrics: {len(metrics_rows)} rows")
print(f"  sus_responses:      0 rows (not administered)")

# ── Summary ───────────────────────────────────────────────────────
print("\n=== TTD Summary ===")
for cond in CONDITIONS:
    vals = ttd_summary[cond]
    mean = sum(vals) / len(vals)
    sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals))
    print(f"  {cond}: n={len(vals)}, mean={mean:.0f}s, sd={sd:.0f}s (target: {TTD_PARAMS[cond]})")

print("\n=== Decision Mix ===")
dec_counts = {c: {} for c in CONDITIONS}
for (sid, case_id, rank, *_, decision) in attempt_rows:
    cond = sid.split("-")[1]
    dec_counts[cond][decision] = dec_counts[cond].get(decision, 0) + 1
for cond in CONDITIONS:
    total = sum(dec_counts[cond].values())
    parts = ", ".join(f"{k}={v}({100*v/total:.0f}%)" for k, v in sorted(dec_counts[cond].items()))
    print(f"  {cond}: {parts}")

print("\n=== NASA-TLX (raw_tlx from 6 subscales) ===")
for cond in CONDITIONS:
    vals = nasa_summary[cond]
    mean = sum(vals) / len(vals)
    sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals))
    print(f"  {cond}: n={len(vals)}, mean={mean:.1f}, sd={sd:.1f} (target: {NASATLX_PARAMS[cond]})")

print("\n=== Condition Order Counterbalancing ===")
for rev in REVIEWERS:
    orders = [(CONDITION_ORDER[(rev, c)], c) for c in CONDITIONS]
    orders.sort()
    seq = " -> ".join(f"{c}({o})" for o, c in orders)
    print(f"  {rev}: {seq}")

print("\n=== Heatmap Exposure vs Use ===")
for cond in CONDITIONS:
    exposed = sum(1 for a in attempt_rows if a[0].endswith(f"-{cond}") and a[8])
    used = sum(1 for a in attempt_rows if a[0].endswith(f"-{cond}") and a[9])
    print(f"  {cond}: exposed={exposed}/36, used={used}/36 ({(100*used/max(1,exposed)):.0f}% of exposed)")

print("\n[OK] Research dataset generated.")
