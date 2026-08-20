import tempfile
import unittest
from pathlib import Path

import torch
import torch.nn as nn

from lib.checkpoint import CheckpointLock, sha256_file, write_lock
from lib.configs.mcdropout_seg import MCDropoutSeg
from lib.configs.segmentation import Segmentation
from lib.infers.network import (
    build_spleen_unet,
    count_dropout_layers,
    learned_state_shapes,
    load_verified_weights,
)
from lib.model_metadata import MODEL_CONFIG


class SpleenModelConfigTest(unittest.TestCase):
    def test_model_metadata_is_ct_spleen_with_authoritative_t15(self):
        self.assertEqual(MODEL_CONFIG.modality, "CT")
        self.assertEqual(MODEL_CONFIG.anatomy, "spleen")
        self.assertEqual(MODEL_CONFIG.mc_samples, 16)
        self.assertEqual(MODEL_CONFIG.dropout_probability, 0.2)
        self.assertEqual(MODEL_CONFIG.uncertainty_threshold, 0.5)
        self.assertEqual(MODEL_CONFIG.target_spacing, (1.5, 1.5, 1.5))
        self.assertEqual(MODEL_CONFIG.intensity_range, (-57.0, 164.0))
        self.assertEqual(MODEL_CONFIG.roi_size, (96, 96, 96))

    def test_c1_and_c2_have_identical_learned_state_shapes(self):
        deterministic = build_spleen_unet(dropout=0.0)
        stochastic = build_spleen_unet(
            dropout=MODEL_CONFIG.dropout_probability
        )

        self.assertEqual(
            learned_state_shapes(deterministic),
            learned_state_shapes(stochastic),
        )
        deterministic_dropout = [
            module.p
            for module in deterministic.modules()
            if isinstance(
                module,
                (nn.Dropout, nn.Dropout1d, nn.Dropout2d, nn.Dropout3d),
            )
        ]
        stochastic_dropout = [
            module.p
            for module in stochastic.modules()
            if isinstance(
                module,
                (nn.Dropout, nn.Dropout1d, nn.Dropout2d, nn.Dropout3d),
            )
        ]
        self.assertGreater(count_dropout_layers(deterministic), 0)
        self.assertGreater(count_dropout_layers(stochastic), 0)
        self.assertTrue(all(value == 0.0 for value in deterministic_dropout))
        self.assertTrue(
            all(
                value == MODEL_CONFIG.dropout_probability
                for value in stochastic_dropout
            )
        )

    def test_verified_checkpoint_loads_identical_learned_tensors_into_c1_c2(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = build_spleen_unet(dropout=0.0)
            checkpoint_path = root / "pretrained_segmentation.pt"
            lock_path = root / "checkpoint.lock.json"
            torch.save(source.state_dict(), checkpoint_path)
            write_lock(
                lock_path,
                CheckpointLock(
                    model_id="monailabel-radiology-spleen-unet",
                    model_version=(
                        "pretrained/"
                        "radiology_segmentation_unet_spleen_total_seg.pt"
                    ),
                    source_url=(
                        "https://github.com/Project-MONAI/MONAILabel/"
                        "releases/download/pretrained/"
                        "radiology_segmentation_unet_spleen_total_seg.pt"
                    ),
                    sha256=sha256_file(checkpoint_path),
                    size_bytes=checkpoint_path.stat().st_size,
                    modality="CT",
                    anatomy="spleen",
                    license="Apache-2.0",
                ),
            )
            deterministic = build_spleen_unet(dropout=0.0)
            stochastic = build_spleen_unet(
                dropout=MODEL_CONFIG.dropout_probability
            )

            load_verified_weights(deterministic, checkpoint_path, lock_path)
            load_verified_weights(stochastic, checkpoint_path, lock_path)

            deterministic_state = deterministic.state_dict()
            stochastic_state = stochastic.state_dict()
            for key in deterministic_state:
                self.assertTrue(
                    torch.equal(
                        deterministic_state[key],
                        stochastic_state[key],
                    ),
                    key,
                )

    def test_loader_rejects_missing_learned_tensor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = build_spleen_unet(dropout=0.0)
            state = source.state_dict()
            state.pop(next(iter(state)))
            checkpoint_path = root / "pretrained_segmentation.pt"
            lock_path = root / "checkpoint.lock.json"
            torch.save(state, checkpoint_path)
            write_lock(
                lock_path,
                CheckpointLock(
                    model_id="monailabel-radiology-spleen-unet",
                    model_version=(
                        "pretrained/"
                        "radiology_segmentation_unet_spleen_total_seg.pt"
                    ),
                    source_url=(
                        "https://github.com/Project-MONAI/MONAILabel/"
                        "releases/download/pretrained/"
                        "radiology_segmentation_unet_spleen_total_seg.pt"
                    ),
                    sha256=sha256_file(checkpoint_path),
                    size_bytes=checkpoint_path.stat().st_size,
                    modality="CT",
                    anatomy="spleen",
                    license="Apache-2.0",
                ),
            )

            with self.assertRaisesRegex(RuntimeError, "strict"):
                load_verified_weights(
                    build_spleen_unet(dropout=0.0),
                    checkpoint_path,
                    lock_path,
                )

    def test_task_configs_construct_from_verified_checkpoint(self):
        deterministic = Segmentation()
        deterministic.init(
            name="segmentation",
            model_dir="/workspace/app/model",
            conf={},
            planner=None,
        )
        stochastic = MCDropoutSeg()
        stochastic.init(
            name="mcdropout_seg",
            model_dir="/workspace/app/model",
            conf={},
            planner=None,
        )

        self.assertIsNone(deterministic.path)
        self.assertIsNone(stochastic.path)
        self.assertEqual(stochastic.num_samples, 16)
        self.assertEqual(
            deterministic.checkpoint_lock.sha256,
            stochastic.checkpoint_lock.sha256,
        )


if __name__ == "__main__":
    unittest.main()
