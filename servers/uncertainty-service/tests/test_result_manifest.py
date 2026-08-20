import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.result_manifest import (
    ManifestValidationError,
    load_manifest,
    manifest_to_inference_response,
    validate_manifest,
)


def artifact(path: Path, content: bytes, media_type: str) -> dict:
    path.write_bytes(content)
    return {
        "filename": path.name,
        "sha256": hashlib.sha256(content).hexdigest(),
        "size_bytes": len(content),
        "media_type": media_type,
    }


def valid_c2_manifest(root: Path) -> dict:
    return {
        "case_id": "case.001",
        "patient_id": "patient001",
        "study_uid": "study.001",
        "series_uid": "series.001",
        "modality": "CT",
        "anatomy": "spleen",
        "condition": "C2",
        "task": "mcdropout_seg",
        "checkpoint": {
            "model_id": "monailabel-radiology-spleen-unet",
            "version": (
                "pretrained/"
                "radiology_segmentation_unet_spleen_total_seg.pt"
            ),
            "sha256": (
                "b606697f9efad300bbb3b1115abd1245"
                "b29e5de0c9de8fac052ab6d2d94f920a"
            ),
            "size_bytes": 19297197,
        },
        "num_samples": 16,
        "dropout_probability": 0.2,
        "threshold": 0.5,
        "metrics_version": "ct-spleen-v1",
        "artifact_generation": "11111111-1111-4111-8111-111111111111",
        "provenance_category": "checkpoint_experiment",
        "artifacts": {
            "segmentation": artifact(
                root / "segmentation.nii.gz",
                b"segmentation",
                "application/gzip",
            ),
            "uncertainty": artifact(
                root / "uncertainty.nii.gz",
                b"uncertainty",
                "application/gzip",
            ),
            "foreground_probability": artifact(
                root / "foreground_probability.nii.gz",
                b"probability",
                "application/gzip",
            ),
        },
        "operational_scores": {
            "score": 0.683,
            "score_p95": 0.692,
            "score_fraction_above": 1.0,
            "score_mean_all": 0.5,
            "band": "high",
        },
        "runtime_seconds": {"total": 12.5},
    }


class ResultManifestTest(unittest.TestCase):
    def test_validates_complete_c2_manifest_and_projects_api_response(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = valid_c2_manifest(root)
            path = root / "result.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")

            loaded = load_manifest(path)
            validate_manifest(loaded, root)
            response = manifest_to_inference_response(
                loaded,
                "http://localhost:58050",
                cache_hit=True,
            )

            self.assertEqual(response["case_id"], "case.001")
            self.assertEqual(response["num_samples"], 16)
            self.assertEqual(
                response["checkpoint_sha256"],
                (
                    "b606697f9efad300bbb3b1115abd1245"
                    "b29e5de0c9de8fac052ab6d2d94f920a"
                ),
            )
            self.assertEqual(response["score"], 0.683)
            self.assertTrue(response["cache_hit"])
            self.assertIn(
                "/files/case.001/C2/segmentation.nii.gz",
                response["segmentation_url"],
            )
            self.assertIn(
                "/files/case.001/C2/uncertainty.nii.gz",
                response["uncertainty_url"],
            )
            self.assertIn(
                "/results/case.001?condition=C2",
                response["result_url"],
            )

    def test_rejects_wrong_t_or_missing_probability(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = valid_c2_manifest(root)
            manifest["num_samples"] = 15
            del manifest["artifacts"]["foreground_probability"]

            with self.assertRaises(ManifestValidationError):
                validate_manifest(manifest, root)

    def test_rejects_tampered_artifact_and_synthetic_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = valid_c2_manifest(root)
            (root / "uncertainty.nii.gz").write_bytes(b"tampered")

            with self.assertRaisesRegex(
                ManifestValidationError,
                "uncertainty",
            ):
                validate_manifest(manifest, root)

    def test_rejects_unapproved_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = valid_c2_manifest(root)
            manifest["checkpoint"]["sha256"] = "a" * 64

            with self.assertRaisesRegex(
                ManifestValidationError,
                "official checkpoint",
            ):
                validate_manifest(manifest, root)

            manifest = valid_c2_manifest(root)
            manifest["provenance_category"] = "synthetic_plumbing_validation"
            with self.assertRaisesRegex(
                ManifestValidationError,
                "provenance",
            ):
                validate_manifest(manifest, root)

    def test_c1_requires_only_segmentation_and_one_sample(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = valid_c2_manifest(root)
            manifest["condition"] = "C1"
            manifest["task"] = "segmentation"
            manifest["num_samples"] = 1
            manifest["dropout_probability"] = 0.0
            manifest["artifacts"] = {
                "segmentation": manifest["artifacts"]["segmentation"]
            }
            validate_manifest(manifest, root)

            response = manifest_to_inference_response(
                manifest,
                "http://localhost:58050",
                cache_hit=True,
            )
            self.assertIsNone(response["uncertainty_url"])
            self.assertEqual(response["num_samples"], 1)


if __name__ == "__main__":
    unittest.main()
