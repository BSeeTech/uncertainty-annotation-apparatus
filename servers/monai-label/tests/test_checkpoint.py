import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from lib.checkpoint import (
    OFFICIAL_CHECKPOINT_URL,
    CheckpointIntegrityError,
    CheckpointLock,
    read_lock,
    verify_checkpoint,
    write_lock,
)


class CheckpointIntegrityTest(unittest.TestCase):
    def test_verifies_matching_checkpoint_and_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            checkpoint = root / "pretrained_segmentation.pt"
            lock_path = root / "checkpoint.lock.json"
            payload = b"official-spleen-checkpoint-fixture"
            checkpoint.write_bytes(payload)
            expected = CheckpointLock(
                model_id="monailabel-radiology-spleen-unet",
                model_version=(
                    "pretrained/"
                    "radiology_segmentation_unet_spleen_total_seg.pt"
                ),
                source_url=OFFICIAL_CHECKPOINT_URL,
                sha256=hashlib.sha256(payload).hexdigest(),
                size_bytes=len(payload),
                modality="CT",
                anatomy="spleen",
                license="Apache-2.0",
            )
            write_lock(lock_path, expected)

            verified = verify_checkpoint(checkpoint, lock_path)

            self.assertEqual(verified, expected)
            self.assertEqual(read_lock(lock_path), expected)

    def test_rejects_checkpoint_with_wrong_sha256(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            checkpoint = root / "pretrained_segmentation.pt"
            lock_path = root / "checkpoint.lock.json"
            checkpoint.write_bytes(b"tampered")
            write_lock(
                lock_path,
                CheckpointLock(
                    model_id="monailabel-radiology-spleen-unet",
                    model_version=(
                        "pretrained/"
                        "radiology_segmentation_unet_spleen_total_seg.pt"
                    ),
                    source_url=OFFICIAL_CHECKPOINT_URL,
                    sha256=hashlib.sha256(b"expected").hexdigest(),
                    size_bytes=len(b"tampered"),
                    modality="CT",
                    anatomy="spleen",
                    license="Apache-2.0",
                ),
            )

            with self.assertRaisesRegex(
                CheckpointIntegrityError,
                "SHA-256",
            ):
                verify_checkpoint(checkpoint, lock_path)

    def test_rejects_missing_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock_path = root / "checkpoint.lock.json"
            write_lock(
                lock_path,
                CheckpointLock(
                    model_id="monailabel-radiology-spleen-unet",
                    model_version=(
                        "pretrained/"
                        "radiology_segmentation_unet_spleen_total_seg.pt"
                    ),
                    source_url=OFFICIAL_CHECKPOINT_URL,
                    sha256=hashlib.sha256(b"expected").hexdigest(),
                    size_bytes=len(b"expected"),
                    modality="CT",
                    anatomy="spleen",
                    license="Apache-2.0",
                ),
            )

            with self.assertRaisesRegex(
                CheckpointIntegrityError,
                "missing",
            ):
                verify_checkpoint(root / "missing.pt", lock_path)

    def test_rejects_placeholder_or_malformed_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "checkpoint.lock.json"
            lock_path.write_text(
                json.dumps(
                    {
                        "model_id": "monailabel-radiology-spleen-unet",
                        "model_version": (
                            "pretrained/"
                            "radiology_segmentation_unet_spleen_total_seg.pt"
                        ),
                        "source_url": OFFICIAL_CHECKPOINT_URL,
                        "sha256": "<checkpoint-sha256>",
                        "size_bytes": 123,
                        "modality": "CT",
                        "anatomy": "spleen",
                        "license": "Apache-2.0",
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                CheckpointIntegrityError,
                "64 lowercase",
            ):
                read_lock(lock_path)

    def test_rejects_non_official_source_or_wrong_modality(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "checkpoint.lock.json"
            lock_path.write_text(
                json.dumps(
                    {
                        "model_id": "monailabel-radiology-spleen-unet",
                        "model_version": (
                            "pretrained/"
                            "radiology_segmentation_unet_spleen_total_seg.pt"
                        ),
                        "source_url": "https://example.invalid/model.pt",
                        "sha256": "a" * 64,
                        "size_bytes": 123,
                        "modality": "MR",
                        "anatomy": "spleen",
                        "license": "Apache-2.0",
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaises(CheckpointIntegrityError):
                read_lock(lock_path)


if __name__ == "__main__":
    unittest.main()
