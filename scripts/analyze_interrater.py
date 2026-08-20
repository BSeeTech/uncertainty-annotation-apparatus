#!/usr/bin/env python3
"""analyze_interrater.py — pairwise inter-rater agreement analysis.

Computes pairwise Dice similarity between reviewer final masks for the
same case seen in the same condition.  If agreement is low in C1 but
high in C2/C5, that is evidence that uncertainty information converges
opinions — a useful signal even without ground truth.

Usage:
    python scripts/analyze_interrater.py \\
        --db-url postgresql://user:pass@host/db \\
        --output /tmp/interrater-report.json

Requires: nibabel, numpy, scipy
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


def dice_coefficient(a: np.ndarray, b: np.ndarray) -> float:
    """Compute Sørensen–Dice coefficient for two binary masks."""
    intersection = np.sum((a > 0) & (b > 0))
    sum_ab = np.sum(a > 0) + np.sum(b > 0)
    if sum_ab == 0:
        return 1.0  # both empty → perfect agreement
    return 2.0 * intersection / sum_ab


def compute_pairwise_agreement(
    annotations: list[dict],
) -> dict[str, list[dict]]:
    """Group annotations by (case_id, condition) and compute pairwise Dice.

    Returns { "case_001/C2": [{"reviewers": ["R01","R03"], "dice": 0.87}, ...] }
    """
    # Group by (case_id, condition)
    groups = defaultdict(list)
    for a in annotations:
        key = f"{a['case_id']}/{a['condition']}"
        groups[key].append(a)

    results = {}
    for key, group in groups.items():
        if len(group) < 2:
            continue  # need at least 2 reviewers for pairwise comparison

        pairs = []
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                mask_a = group[i].get("mask_array")
                mask_b = group[j].get("mask_array")
                if mask_a is None or mask_b is None:
                    continue
                dice = dice_coefficient(np.array(mask_a), np.array(mask_b))
                pairs.append(
                    {
                        "reviewers": [
                            group[i]["reviewer_id"],
                            group[j]["reviewer_id"],
                        ],
                        "dice": round(float(dice), 4),
                    }
                )

        if pairs:
            dices = [p["dice"] for p in pairs]
            results[key] = {
                "case_id": group[0]["case_id"],
                "condition": group[0]["condition"],
                "n_reviewers": len(group),
                "n_pairs": len(pairs),
                "mean_dice": round(float(np.mean(dices)), 4),
                "std_dice": round(float(np.std(dices)), 4),
                "min_dice": round(float(np.min(dices)), 4),
                "max_dice": round(float(np.max(dices)), 4),
                "pairs": pairs,
            }

    return results


def compare_across_conditions(
    results: dict[str, dict],
) -> dict[str, dict]:
    """Compare agreement across conditions for shared cases.

    If a case was annotated by multiple reviewers in different conditions,
    we can compare whether uncertainty display (C2/C5) produces more
    consistent annotations than AI-only (C1) or manual (C0).
    """
    # Group by case_id
    by_case = defaultdict(list)
    for key, r in results.items():
        by_case[r["case_id"]].append(r)

    comparison = {}
    for case_id, conds in by_case.items():
        if len(conds) < 2:
            continue
        entry = {
            "case_id": case_id,
            "conditions": {},
            "agreement_delta": {},
        }
        for c in conds:
            entry["conditions"][c["condition"]] = {
                "mean_dice": c["mean_dice"],
                "n_reviewers": c["n_reviewers"],
            }

        # Compute deltas
        if "C0" in entry["conditions"] and "C2" in entry["conditions"]:
            entry["agreement_delta"]["C2_vs_C0"] = round(
                entry["conditions"]["C2"]["mean_dice"]
                - entry["conditions"]["C0"]["mean_dice"],
                4,
            )
        if "C1" in entry["conditions"] and "C2" in entry["conditions"]:
            entry["agreement_delta"]["C2_vs_C1"] = round(
                entry["conditions"]["C2"]["mean_dice"]
                - entry["conditions"]["C1"]["mean_dice"],
                4,
            )
        if "C0" in entry["conditions"] and "C5" in entry["conditions"]:
            entry["agreement_delta"]["C5_vs_C0"] = round(
                entry["conditions"]["C5"]["mean_dice"]
                - entry["conditions"]["C0"]["mean_dice"],
                4,
            )

        comparison[case_id] = entry

    return comparison


def load_annotations_from_fixture(path: Path) -> list[dict]:
    """Load annotation data from a JSON fixture.

    Expected format:
    [
        {
            "case_id": "case_001",
            "reviewer_id": "R01",
            "condition": "C2",
            "mask_array": [[0,0,1,1,...], ...]  # flattened binary mask
        },
        ...
    ]
    """
    with open(path) as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(
        description="Compute pairwise inter-rater agreement."
    )
    parser.add_argument(
        "--fixture", type=Path, required=True,
        help="JSON fixture with annotation mask arrays",
    )
    parser.add_argument(
        "--output", "-o", type=Path, default="/tmp/interrater-report.json",
    )
    args = parser.parse_args()

    annotations = load_annotations_from_fixture(args.fixture)
    print(f"Loaded {len(annotations)} annotations")

    results = compute_pairwise_agreement(annotations)
    print(f"Computed agreement for {len(results)} case×condition groups")

    comparison = compare_across_conditions(results)
    print(f"Cross-condition comparison for {len(comparison)} cases")

    # Aggregate summary per condition
    by_condition = defaultdict(list)
    for key, r in results.items():
        by_condition[r["condition"]].append(r["mean_dice"])

    condition_summary = {}
    for cond, dices in by_condition.items():
        condition_summary[cond] = {
            "n_groups": len(dices),
            "mean_dice": round(float(np.mean(dices)), 4),
            "std_dice": round(float(np.std(dices)), 4),
        }

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_annotations": len(annotations),
        "condition_summary": condition_summary,
        "comparison": comparison,
        "details": results,
        "interpretation": _generate_interpretation(condition_summary, comparison),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\nReport written to {args.output}")
    print("\nAgreement by condition:")
    for cond, s in sorted(condition_summary.items()):
        print(f"  {cond}: mean Dice = {s['mean_dice']:.4f} (n={s['n_groups']})")

    if comparison:
        print("\nCross-condition agreement deltas:")
        for case_id, c in comparison.items():
            for k, v in c["agreement_delta"].items():
                direction = "↑" if v > 0 else "↓" if v < 0 else "→"
                print(f"  {case_id} {k}: {direction} {abs(v):.4f}")


def _generate_interpretation(
    condition_summary: dict, comparison: dict
) -> str:
    """Generate a human-readable interpretation of the findings."""
    lines = ["## Inter-Rater Agreement Interpretation\n"]

    if "C0" in condition_summary:
        c0 = condition_summary["C0"]["mean_dice"]
        lines.append(
            f"- **Manual (C0):** mean Dice = {c0:.3f}. "
            "This is the baseline inter-rater variability for the task. "
        )

    if "C1" in condition_summary:
        c1 = condition_summary["C1"]["mean_dice"]
        lines.append(
            f"- **AI-only (C1):** mean Dice = {c1:.3f}. "
        )

    if "C2" in condition_summary:
        c2 = condition_summary["C2"]["mean_dice"]
        lines.append(
            f"- **Uncertainty-guided (C2):** mean Dice = {c2:.3f}. "
        )

    if "C5" in condition_summary:
        c5 = condition_summary["C5"]["mean_dice"]
        lines.append(
            f"- **Heatmap-only (C5):** mean Dice = {c5:.3f}. "
        )

    # Check for convergence signal
    deltas = []
    for case_id, c in comparison.items():
        for k, v in c["agreement_delta"].items():
            if abs(v) > 0.02:
                deltas.append((case_id, k, v))

    if deltas:
        positive = sum(1 for _, _, v in deltas if v > 0)
        negative = sum(1 for _, _, v in deltas if v < 0)
        if positive > negative * 2:
            lines.append(
                "\n- **Convergence signal detected.** Agreement is consistently higher "
                "in uncertainty/heatmap conditions than in baseline conditions. "
                "This suggests the visualisation converges reviewer opinions."
            )
        elif negative > positive * 2:
            lines.append(
                "\n- **Divergence signal detected.** Agreement is consistently lower "
                "in uncertainty/heatmap conditions. "
                "The visualisation may be causing reviewers to make different "
                "interpretations of the same entropy signal."
            )
        else:
            lines.append(
                "\n- **No clear convergence signal.** Agreement differences between "
                "conditions are small or inconsistent. "
                "The visualisation may not materially change reviewer agreement."
            )

    return "\n".join(lines)


if __name__ == "__main__":
    main()
