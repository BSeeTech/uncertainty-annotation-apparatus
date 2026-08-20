import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import torch
import torch.nn as nn
from monai.data import MetaTensor

from lib.checkpoint import CheckpointLock
from lib.infers.mcdropout_seg import MCDropoutSegmentation
from lib.infers.segmentation import Segmentation
from lib.model_metadata import MODEL_CONFIG
from monailabel.tasks.infer.basic_infer import BasicInferTask


CHECKPOINT_LOCK = CheckpointLock(
    model_id="monailabel-radiology-spleen-unet",
    model_version=(
        "pretrained/radiology_segmentation_unet_spleen_total_seg.pt"
    ),
    source_url=(
        "https://github.com/Project-MONAI/MONAILabel/releases/download/"
        "pretrained/radiology_segmentation_unet_spleen_total_seg.pt"
    ),
    sha256="a" * 64,
    size_bytes=123,
    modality="CT",
    anatomy="spleen",
    license="Apache-2.0",
)


class TinyDropoutNetwork(nn.Module):
    def __init__(self):
        super().__init__()
        self.dropout = nn.Dropout3d(p=0.2)

    def forward(self, inputs):
        foreground = self.dropout(inputs)
        return torch.cat((-foreground, foreground), dim=1)


class TinyNoDropoutNetwork(nn.Module):
    def __init__(self):
        super().__init__()
        self.identity = nn.Identity()

    def forward(self, inputs):
        foreground = self.identity(inputs)
        return torch.cat((-foreground, foreground), dim=1)


class InferenceOutputTest(unittest.TestCase):
    def test_tasks_use_official_ct_preprocessing(self):
        deterministic = Segmentation(
            path=None,
            network=TinyDropoutNetwork(),
            labels={1: "spleen"},
            checkpoint_lock=CHECKPOINT_LOCK,
        )
        stochastic = MCDropoutSegmentation(
            path=None,
            network=TinyDropoutNetwork(),
            labels={1: "spleen"},
            checkpoint_lock=CHECKPOINT_LOCK,
        )

        for task in (deterministic, stochastic):
            self.assertEqual(task.target_spacing, (1.5, 1.5, 1.5))
            self.assertEqual(task.intensity_range, (-57.0, 164.0))
            self.assertEqual(task.spatial_size, (96, 96, 96))
            transform_names = [
                transform.__class__.__name__
                for transform in task.pre_transforms()
            ]
            self.assertIn("ScaleIntensityRanged", transform_names)
            self.assertIn("ScaleIntensityd", transform_names)
            self.assertIn(
                "KeepLargestConnectedComponentd",
                [
                    transform.__class__.__name__
                    for transform in task.post_transforms()
                ],
            )

    def test_c2_run_inferer_produces_probability_entropy_and_metadata(self):
        task = MCDropoutSegmentation(
            path=None,
            network=TinyDropoutNetwork(),
            labels={1: "spleen"},
            checkpoint_lock=CHECKPOINT_LOCK,
            num_samples=4,
            spatial_size=(2, 2, 2),
        )
        task._get_network = lambda device, data: task.network
        task.inferer = lambda data=None: (
            lambda inputs, network: network(inputs)
        )
        image = MetaTensor(torch.ones((1, 2, 2, 2)))

        result = task.run_inferer(
            {"image": image},
            convert_to_batch=True,
            device="cpu",
        )

        self.assertEqual(tuple(result["pred"].shape), (1, 2, 2, 2))
        self.assertEqual(
            tuple(result["pred_entropy"].shape),
            (1, 2, 2, 2),
        )
        self.assertEqual(
            tuple(result["pred_probability"].shape),
            (1, 2, 2, 2),
        )
        self.assertTrue(torch.all(result["pred_probability"] >= 0))
        self.assertTrue(torch.all(result["pred_probability"] <= 1))
        self.assertEqual(result["runtime_metadata"]["num_samples"], 4)
        self.assertEqual(result["runtime_metadata"]["mc_samples"], 4)
        self.assertEqual(result["runtime_metadata"]["modality"], "CT")
        self.assertEqual(
            result["runtime_metadata"]["checkpoint_sha256"],
            CHECKPOINT_LOCK.sha256,
        )

    def test_c2_run_inferer_raises_on_dropout_free_network(self):
        """A checkpoint with no Dropout layers would silently return T
        identical passes -- zero entropy everywhere, no signal for a
        reviewer to detect it. run_inferer must refuse to run rather than
        produce that output."""
        task = MCDropoutSegmentation(
            path=None,
            network=TinyNoDropoutNetwork(),
            labels={1: "spleen"},
            checkpoint_lock=CHECKPOINT_LOCK,
            num_samples=4,
            spatial_size=(2, 2, 2),
        )
        task._get_network = lambda device, data: task.network
        task.inferer = lambda data=None: (
            lambda inputs, network: network(inputs)
        )
        image = MetaTensor(torch.ones((1, 2, 2, 2)))

        with self.assertRaises(ValueError):
            task.run_inferer(
                {"image": image},
                convert_to_batch=True,
                device="cpu",
            )

    def test_c2_writer_emits_stable_complete_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            segmentation = root / "prediction.nii.gz"
            segmentation.write_bytes(b"segmentation")
            task = MCDropoutSegmentation(
                path=None,
                network=TinyDropoutNetwork(),
                labels={1: "spleen"},
                checkpoint_lock=CHECKPOINT_LOCK,
                num_samples=MODEL_CONFIG.mc_samples,
            )
            tensor = MetaTensor(torch.ones((1, 2, 2, 2)))
            data = {
                "pred_entropy": tensor,
                "pred_probability": tensor * 0.75,
                "runtime_metadata": {
                    "num_samples": MODEL_CONFIG.mc_samples,
                    "modality": "CT",
                    "checkpoint_sha256": CHECKPOINT_LOCK.sha256,
                },
            }

            with patch.object(
                BasicInferTask,
                "writer",
                return_value=(str(segmentation), {"latencies": {"total": 1.2}}),
            ):
                archive_path, result = task.writer(data)

            with zipfile.ZipFile(archive_path) as archive:
                self.assertEqual(
                    set(archive.namelist()),
                    {
                        "segmentation.nii.gz",
                        "uncertainty.nii.gz",
                        "foreground_probability.nii.gz",
                        "result.json",
                    },
                )
            self.assertEqual(result["num_samples"], 16)
            self.assertEqual(result["checkpoint_sha256"], "a" * 64)


if __name__ == "__main__":
    unittest.main()
