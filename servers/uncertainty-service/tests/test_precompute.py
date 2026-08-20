import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.precompute import stage_monai_result
from app.result_manifest import load_manifest, validate_manifest
from tests.test_contract import nifti_bytes


def monai_bundle(condition: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "segmentation.nii.gz",
            nifti_bytes((0, 1, 1, 0)),
        )
        if condition == "C2":
            archive.writestr(
                "uncertainty.nii.gz",
                nifti_bytes((0.1, 0.6, 0.8, 0.2), datatype=16),
            )
            archive.writestr(
                "foreground_probability.nii.gz",
                nifti_bytes((0.1, 0.9, 0.8, 0.2), datatype=16),
            )
        archive.writestr(
            "result.json",
            json.dumps(
                {
                    "model_id": "monailabel-radiology-spleen-unet",
                    "model_version": (
                        "pretrained/"
                        "radiology_segmentation_unet_spleen_total_seg.pt"
                    ),
                    "checkpoint_sha256": (
                        "b606697f9efad300bbb3b1115abd1245"
                        "b29e5de0c9de8fac052ab6d2d94f920a"
                    ),
                    "checkpoint_size_bytes": 19297197,
                    "num_samples": 16 if condition == "C2" else 1,
                    "dropout_probability": 0.2 if condition == "C2" else 0.0,
                    "uncertainty_threshold": 0.5,
                    "latencies": {"total": 12.5},
                }
            ),
        )
    return buffer.getvalue()


class PrecomputeStagingTest(unittest.TestCase):
    def test_stages_complete_c2_generation_from_monai_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp) / "staging"
            case = {
                "case_id": "case.001",
                "patient_id": "patient001",
                "study_uid": "study.001",
                "series_uid": "series.001",
            }

            manifest = stage_monai_result(
                case,
                "C2",
                monai_bundle("C2"),
                staging,
            )

            self.assertEqual(manifest["num_samples"], 16)
            self.assertAlmostEqual(
                manifest["operational_scores"]["score"],
                0.7,
            )
            self.assertEqual(
                set(manifest["artifacts"]),
                {
                    "segmentation",
                    "uncertainty",
                    "foreground_probability",
                },
            )
            validate_manifest(load_manifest(staging / "result.json"), staging)

    def test_rejects_c2_bundle_without_probability(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(
                "segmentation.nii.gz",
                nifti_bytes((0, 1)),
            )
            archive.writestr(
                "uncertainty.nii.gz",
                nifti_bytes((0.1, 0.6), datatype=16),
            )
            archive.writestr(
                "result.json",
                json.dumps(
                    {
                        "model_id": "monailabel-radiology-spleen-unet",
                        "model_version": "v",
                        "checkpoint_sha256": (
                            "b606697f9efad300bbb3b1115abd1245"
                            "b29e5de0c9de8fac052ab6d2d94f920a"
                        ),
                        "checkpoint_size_bytes": 19297197,
                        "num_samples": 16,
                        "dropout_probability": 0.2,
                        "uncertainty_threshold": 0.5,
                    }
                ),
            )

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "foreground_probability"):
                stage_monai_result(
                    {
                        "case_id": "case.001",
                        "patient_id": "patient001",
                        "study_uid": "study.001",
                        "series_uid": "series.001",
                    },
                    "C2",
                    buffer.getvalue(),
                    Path(tmp) / "staging",
                )


if __name__ == "__main__":
    unittest.main()
