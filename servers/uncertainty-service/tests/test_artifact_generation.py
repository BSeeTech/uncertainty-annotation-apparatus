import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.artifact_generation import (
    current_generation_dir,
    publish_generation,
)
from app.result_manifest import ManifestValidationError
from tests.test_result_manifest import valid_c2_manifest


class ArtifactGenerationTest(unittest.TestCase):
    def test_publishes_complete_generation_and_resolves_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            staging.mkdir()
            manifest = valid_c2_manifest(staging)
            (staging / "result.json").write_text(
                json.dumps(manifest),
                encoding="utf-8",
            )

            published = publish_generation(
                root / "case.001",
                "C2",
                staging,
            )

            self.assertEqual(
                published.name,
                manifest["artifact_generation"],
            )
            self.assertEqual(
                current_generation_dir(root / "case.001", "C2"),
                published,
            )
            self.assertTrue((published / "result.json").exists())

    def test_invalid_replacement_preserves_previous_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case_root = root / "case.001"
            first = root / "first"
            first.mkdir()
            manifest = valid_c2_manifest(first)
            (first / "result.json").write_text(
                json.dumps(manifest),
                encoding="utf-8",
            )
            previous = publish_generation(case_root, "C2", first)

            incomplete = root / "incomplete"
            shutil.copytree(previous, incomplete)
            (incomplete / "uncertainty.nii.gz").unlink()
            replacement = json.loads(
                (incomplete / "result.json").read_text(encoding="utf-8")
            )
            replacement["artifact_generation"] = (
                "22222222-2222-4222-8222-222222222222"
            )
            (incomplete / "result.json").write_text(
                json.dumps(replacement),
                encoding="utf-8",
            )

            with self.assertRaises(ManifestValidationError):
                publish_generation(case_root, "C2", incomplete)

            self.assertEqual(
                current_generation_dir(case_root, "C2"),
                previous,
            )

    def test_c1_and_c2_currents_are_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case_root = root / "case.001"
            c2_staging = root / "c2"
            c2_staging.mkdir()
            c2_manifest = valid_c2_manifest(c2_staging)
            (c2_staging / "result.json").write_text(
                json.dumps(c2_manifest),
                encoding="utf-8",
            )
            c2_dir = publish_generation(case_root, "C2", c2_staging)

            c1_staging = root / "c1"
            c1_staging.mkdir()
            c1_manifest = valid_c2_manifest(c1_staging)
            c1_manifest["condition"] = "C1"
            c1_manifest["task"] = "segmentation"
            c1_manifest["num_samples"] = 1
            c1_manifest["dropout_probability"] = 0.0
            c1_manifest["artifact_generation"] = (
                "33333333-3333-4333-8333-333333333333"
            )
            c1_manifest["artifacts"] = {
                "segmentation": c1_manifest["artifacts"]["segmentation"]
            }
            (c1_staging / "result.json").write_text(
                json.dumps(c1_manifest),
                encoding="utf-8",
            )
            c1_dir = publish_generation(case_root, "C1", c1_staging)

            self.assertEqual(current_generation_dir(case_root, "C1"), c1_dir)
            self.assertEqual(current_generation_dir(case_root, "C2"), c2_dir)


if __name__ == "__main__":
    unittest.main()
