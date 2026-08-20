"""Render a concise Markdown report from an evaluation JSON document."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from run_evaluation import (
    EXPERIMENTAL_PROVENANCE,
    PLUMBING_PROVENANCE,
    validate_experimental_report,
)


def _value(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def render_report(report: dict[str, Any]) -> str:
    provenance = report.get("provenance_category")
    if provenance == EXPERIMENTAL_PROVENANCE:
        validate_experimental_report(report)
        title = "CT Spleen Checkpoint Experiment"
    elif provenance == PLUMBING_PROVENANCE:
        title = "Synthetic Plumbing Validation"
    else:
        raise ValueError("unknown report provenance category")

    lines = [
        f"# {title}",
        "",
        f"- Provenance: `{provenance}`",
        f"- Generated: {report.get('generated_at', 'unknown')}",
        "",
        "## Cases",
        "",
        "| Patient | Reference | Mean entropy | Dice | Runtime (s) |",
        "|---|---:|---:|---:|---:|",
    ]
    for row in report.get("cases", []):
        score = row.get("operational_scores", {}).get("score", "—")
        dice = row.get("segmentation_metrics", {}).get("dice", "—")
        rt = row.get("runtime_seconds", {})
        runtime = (
            rt.get("total")
            or rt.get("monai_inference")
            or next(iter(rt.values()), None)
            or "—"
        )
        runtime_str = _value(runtime) if isinstance(runtime, float) else str(runtime)
        lines.append(
            "| {patient} | {reference} | {score} | {dice} | {runtime} |".format(
                patient=row.get("patient_id", "—"),
                reference="yes" if row.get("reference_mask_available") else "no",
                score=_value(score),
                dice=_value(dice),
                runtime=runtime_str,
            )
        )

    if provenance == EXPERIMENTAL_PROVENANCE:
        lines.extend(
            [
                "",
                "## Claim boundary",
                "",
                "Segmentation quality, calibration, and uncertainty-error "
                "metrics use patient001–patient003 only. Runtime and workflow "
                "results use all five CT cases. Synthetic smoke results are "
                "reported separately and are not included here.",
            ]
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = json.loads(args.input.read_text(encoding="utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_report(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
