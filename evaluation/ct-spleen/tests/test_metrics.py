import math
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np


MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

import metrics as metrics_module  # noqa: E402
from metrics import (  # noqa: E402
    aggregate_case_metrics,
    calibration_metrics,
    local_evaluation_region,
    segmentation_metrics,
    uncertainty_metrics,
)


class EvaluationMetricsTest(unittest.TestCase):
    def test_trapezoid_falls_back_for_numpy_1_x(self):
        legacy_numpy = SimpleNamespace(
            trapezoid=None,
            trapz=lambda y, x=None, dx=1.0: 0.25,
        )
        with patch.object(metrics_module, "np", legacy_numpy):
            result = metrics_module._trapezoid(
                np.array([0.0, 1.0]),
                np.array([0.0, 1.0]),
            )

        self.assertEqual(result, 0.25)

    def test_perfect_segmentation_metrics(self):
        mask = np.zeros((5, 5, 5), dtype=bool)
        mask[1:4, 1:4, 1:4] = True

        result = segmentation_metrics(mask, mask, spacing=(1.0, 1.0, 1.0))

        self.assertEqual(result["dice"], 1.0)
        self.assertEqual(result["jaccard"], 1.0)
        self.assertEqual(result["hd95_mm"], 0.0)
        self.assertEqual(result["surface_dice_2mm"], 1.0)
        self.assertEqual(result["predicted_volume_ml"], 0.027)
        self.assertEqual(result["reference_volume_ml"], 0.027)
        self.assertEqual(result["absolute_volume_error_ml"], 0.0)

    def test_disjoint_segmentation_has_zero_overlap_and_physical_hd95(self):
        pred = np.zeros((7, 3, 3), dtype=bool)
        reference = np.zeros_like(pred)
        pred[1, 1, 1] = True
        reference[4, 1, 1] = True

        result = segmentation_metrics(
            pred,
            reference,
            spacing=(2.0, 1.0, 1.0),
        )

        self.assertEqual(result["dice"], 0.0)
        self.assertEqual(result["jaccard"], 0.0)
        self.assertEqual(result["hd95_mm"], 6.0)
        self.assertEqual(result["surface_dice_2mm"], 0.0)

    def test_calibration_metrics_for_perfect_and_known_probabilities(self):
        perfect = calibration_metrics(
            np.array([0.0, 1.0]),
            np.array([0, 1]),
            np.array([True, True]),
        )
        known = calibration_metrics(
            np.array([0.25, 0.75]),
            np.array([0, 1]),
            np.array([True, True]),
        )

        self.assertEqual(perfect["ece_15"], 0.0)
        self.assertEqual(perfect["brier"], 0.0)
        self.assertLess(perfect["nll"], 1e-6)
        self.assertEqual(known["brier"], 0.0625)
        self.assertAlmostEqual(known["nll"], -math.log(0.75))
        self.assertAlmostEqual(known["ece_15"], 0.25)

    def test_local_region_uses_physical_20mm_dilation(self):
        pred = np.zeros((5, 1, 1), dtype=bool)
        reference = np.zeros_like(pred)
        reference[0, 0, 0] = True

        region = local_evaluation_region(
            pred,
            reference,
            spacing=(10.0, 1.0, 1.0),
            dilation_mm=20.0,
        )

        self.assertEqual(region[:, 0, 0].tolist(), [True, True, True, False, False])

    def test_uncertainty_detects_errors(self):
        pred = np.array([0, 1, 0, 1], dtype=bool)
        reference = np.array([0, 0, 0, 0], dtype=bool)
        entropy = np.array([0.1, 0.9, 0.2, 0.8])
        region = np.ones(4, dtype=bool)

        result = uncertainty_metrics(
            entropy,
            pred,
            reference,
            region,
        )

        self.assertEqual(result["error_auroc"], 1.0)
        self.assertEqual(result["error_auprc"], 1.0)
        self.assertAlmostEqual(result["mean_entropy_correct"], 0.15)
        self.assertAlmostEqual(result["mean_entropy_error"], 0.85)
        self.assertGreaterEqual(result["risk_coverage_auc"], 0.0)
        self.assertLessEqual(result["risk_coverage_auc"], 1.0)

    def test_aggregate_reports_five_summary_statistics(self):
        aggregate = aggregate_case_metrics(
            [
                {"segmentation_metrics": {"dice": 0.5}},
                {"segmentation_metrics": {"dice": 1.0}},
            ]
        )
        dice = aggregate["segmentation_metrics"]["dice"]

        self.assertEqual(dice["mean"], 0.75)
        self.assertEqual(dice["median"], 0.75)
        self.assertEqual(dice["min"], 0.5)
        self.assertEqual(dice["max"], 1.0)
        self.assertAlmostEqual(dice["std"], math.sqrt(0.125))


if __name__ == "__main__":
    unittest.main()
