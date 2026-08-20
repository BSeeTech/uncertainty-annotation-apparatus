import sys
import unittest
from pathlib import Path


MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from render_report import render_report  # noqa: E402
from run_evaluation import (  # noqa: E402
    EXPERIMENTAL_PROVENANCE,
    build_experimental_report,
    json_safe,
    validate_experimental_report,
)


def case_row(index: int, reference: bool) -> dict:
    return {
        "patient_id": f"patient00{index}",
        "case_id": f"case-{index}",
        "provenance_category": EXPERIMENTAL_PROVENANCE,
        "reference_mask_available": reference,
        "operational_scores": {"score": 0.6},
        "segmentation_metrics": {"dice": 0.8} if reference else {},
        "calibration_metrics": {"ece_15": 0.1} if reference else {},
        "uncertainty_metrics": {"error_auroc": 0.7} if reference else {},
        "runtime_seconds": {"total": float(index)},
    }


class EvaluationReportTest(unittest.TestCase):
    def test_experimental_report_separates_quality_and_workflow_scopes(self):
        report = build_experimental_report(
            [case_row(index, index <= 3) for index in range(1, 6)]
        )

        validate_experimental_report(report)
        self.assertEqual(report["provenance_category"], EXPERIMENTAL_PROVENANCE)
        self.assertEqual(len(report["cases"]), 5)
        self.assertEqual(report["quality_scope"]["count"], 3)
        self.assertEqual(report["workflow_scope"]["count"], 5)
        self.assertIn("dice", report["quality_aggregates"]["segmentation_metrics"])
        self.assertIn("total", report["workflow_aggregates"]["runtime_seconds"])

    def test_rejects_synthetic_row_in_experimental_report(self):
        rows = [case_row(index, index <= 3) for index in range(1, 6)]
        rows[0]["provenance_category"] = "synthetic_plumbing_validation"

        with self.assertRaisesRegex(ValueError, "synthetic/plumbing"):
            build_experimental_report(rows)

    def test_renderer_states_reference_claim_boundary(self):
        report = build_experimental_report(
            [case_row(index, index <= 3) for index in range(1, 6)]
        )
        markdown = render_report(report)

        self.assertIn("patient001–patient003 only", markdown)
        self.assertIn("all five CT cases", markdown)
        self.assertIn("Synthetic smoke results are reported separately", markdown)

    def test_non_finite_metric_values_are_serialized_as_null(self):
        value = json_safe({"auroc": float("nan"), "hd95": float("inf")})

        self.assertEqual(value, {"auroc": None, "hd95": None})


if __name__ == "__main__":
    unittest.main()
