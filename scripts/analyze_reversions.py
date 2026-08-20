#!/usr/bin/env python3
"""analyze_reversions.py — detect edit reversions from snapshot traces.

Reads snapshot events from the database and identifies sequences where a
reviewer edited a region and later reverted that edit.  High reversion
rates in high-uncertainty regions suggest the reviewer was second-guessing
rather than correcting; high reversion rates in low-uncertainty regions
suggest potential automation bias.

Usage:
    python scripts/analyze_reversions.py \\
        --db-url postgresql://user:pass@host/db \\
        --output /tmp/reversion-report.json

Output: JSON with per-reviewer, per-condition reversion statistics.
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import asyncpg
except ImportError:
    asyncpg = None  # will fall back to a local JSON fixture for dev


async def fetch_snapshots(pool) -> list[dict]:
    """Fetch all snapshot events ordered by reviewer, case, timestamp."""
    rows = await pool.fetch(
        """
        SELECT e.case_id, e.reviewer_id, e.condition, e.client_ts, e.payload
        FROM events e
        WHERE e.event_type = 'snapshot'
        ORDER BY e.reviewer_id, e.case_id, e.client_ts ASC
        """
    )
    return [dict(r) for r in rows]


def compute_reversion_rate(
    snapshots: list[dict],
) -> dict[str, dict]:
    """Analyse snapshot sequences for edit reversions per reviewer.

    A 'reversion' is defined as: voxelCount increases (edit), then
    subsequently decreases (revert) within the same case.
    """
    # Group by (reviewer_id, case_id)
    groups = defaultdict(list)
    for s in snapshots:
        key = (s["reviewer_id"], s["case_id"])
        groups[key].append(s)

    results = {}
    for (reviewer, case_id), seq in groups.items():
        if len(seq) < 3:
            continue

        reversions = 0
        total_edits = 0
        prev_count = 0
        in_edit = False

        for s in seq:
            payload = s["payload"] or {}
            snap = payload.get("snapshot") or {}
            voxel_count = snap.get("voxelCount", 0)

            if voxel_count > prev_count and not in_edit:
                in_edit = True
                total_edits += 1
            elif voxel_count < prev_count and in_edit:
                in_edit = False
                reversions += 1

            prev_count = voxel_count

        if total_edits > 0:
            cond = seq[0]["condition"]
            key = f"{reviewer}/{cond}"
            if key not in results:
                results[key] = {
                    "reviewer": reviewer,
                    "condition": cond,
                    "total_edits": 0,
                    "reversions": 0,
                    "high_uncertainty_edits": 0,
                    "high_uncertainty_reversions": 0,
                    "low_uncertainty_edits": 0,
                    "low_uncertainty_reversions": 0,
                }
            r = results[key]
            r["total_edits"] += total_edits
            r["reversions"] += reversions

            # If we have band info in the snapshot, classify edits
            # by uncertainty band
            band = (seq[0].get("payload") or {}).get("band")
            if band == "high":
                r["high_uncertainty_edits"] += total_edits
                r["high_uncertainty_reversions"] += reversions
            elif band == "low":
                r["low_uncertainty_edits"] += total_edits
                r["low_uncertainty_reversions"] += reversions

    return results


def compute_trust_trajectory(results: dict) -> list[dict]:
    """Compute per-reviewer trust trajectories from reversion rates.

    A high reversion rate in low-uncertainty regions → potential
    automation bias (reviewer overrides correct AI output then undoes it).
    A high reversion rate in high-uncertainty regions → appropriate
    calibration (reviewer explores uncertain areas but may over-correct).
    """
    trajectories = []
    for key, r in results.items():
        reversion_rate = (
            r["reversions"] / r["total_edits"] if r["total_edits"] > 0 else 0
        )
        high_unc_rev_rate = (
            r["high_uncertainty_reversions"] / r["high_uncertainty_edits"]
            if r["high_uncertainty_edits"] > 0
            else 0
        )
        low_unc_rev_rate = (
            r["low_uncertainty_reversions"] / r["low_uncertainty_edits"]
            if r["low_uncertainty_edits"] > 0
            else 0
        )

        # Signal: if low-uncertainty reversion rate >> high-uncertainty
        # reversion rate, that is consistent with automation bias
        automation_bias_signal = (
            low_unc_rev_rate - high_unc_rev_rate
            if high_unc_rev_rate > 0
            else 0
        )

        trajectories.append(
            {
                "reviewer": r["reviewer"],
                "condition": r["condition"],
                "total_edits": r["total_edits"],
                "reversions": r["reversions"],
                "reversion_rate": round(reversion_rate, 4),
                "high_uncertainty_edits": r["high_uncertainty_edits"],
                "high_uncertainty_reversion_rate": round(high_unc_rev_rate, 4),
                "low_uncertainty_edits": r["low_uncertainty_edits"],
                "low_uncertainty_reversion_rate": round(low_unc_rev_rate, 4),
                "automation_bias_signal": round(automation_bias_signal, 4),
            }
        )

    return sorted(trajectories, key=lambda x: -x["automation_bias_signal"])


async def main():
    parser = argparse.ArgumentParser(
        description="Analyse edit reversions from snapshot traces."
    )
    parser.add_argument("--db-url", default=None, help="PostgreSQL connection URL")
    parser.add_argument(
        "--fixture",
        default=None,
        type=Path,
        help="Local JSON fixture (when no DB is available)",
    )
    parser.add_argument(
        "--output", "-o", default="/tmp/reversion-report.json", type=Path
    )
    args = parser.parse_args()

    if args.fixture:
        with open(args.fixture) as f:
            snapshots = json.load(f)
    elif asyncpg and args.db_url:
        pool = await asyncpg.create_pool(args.db_url, min_size=1, max_size=2)
        try:
            snapshots = await fetch_snapshots(pool)
        finally:
            await pool.close()
    else:
        print(
            "ERROR: provide --db-url or --fixture",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Loaded {len(snapshots)} snapshot events")

    results = compute_reversion_rate(snapshots)
    trajectories = compute_trust_trajectory(results)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_snapshots": len(snapshots),
        "reviewers_analysed": len(
            {k.split("/")[0] for k in results.keys()}
        ),
        "trajectories": trajectories,
        "summary": {
            "mean_reversion_rate": round(
                sum(t["reversion_rate"] for t in trajectories)
                / len(trajectories)
                if trajectories
                else 0,
                4,
            ),
            "mean_automation_bias_signal": round(
                sum(t["automation_bias_signal"] for t in trajectories)
                / len(trajectories)
                if trajectories
                else 0,
                4,
            ),
            "reviewers_with_elevated_bias_signal": sum(
                1 for t in trajectories if t["automation_bias_signal"] > 0.2
            ),
        },
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(report, f, indent=2)

    print(f"Report written to {args.output}")
    print(f"  Reviewers analysed: {report['reviewers_analysed']}")
    print(f"  Mean reversion rate: {report['summary']['mean_reversion_rate']:.4f}")
    print(f"  Mean automation bias signal: {report['summary']['mean_automation_bias_signal']:.4f}")
    print(
        f"  Reviewers with elevated bias: {report['summary']['reviewers_with_elevated_bias_signal']}"
    )

    print("\nTop 5 automation-bias signals:")
    for t in trajectories[:5]:
        print(
            f"  {t['reviewer']} ({t['condition']}): "
            f"reversion_rate={t['reversion_rate']:.3f}, "
            f"bias_signal={t['automation_bias_signal']:.3f}"
        )


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
