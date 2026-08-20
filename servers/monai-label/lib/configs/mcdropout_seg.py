"""TaskConfig for the MC Dropout segmentation task.

This config deliberately mirrors the deterministic ``Segmentation``
config so that the only difference between the two tasks at inference
time is the stochastic-pass loop, not the network or its weights.  The
two tasks therefore share a checkpoint when one is available; this is
what allows the C1 and C2 evaluation conditions to be a clean ablation.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Union

from monailabel.interfaces.config import TaskConfig
from monailabel.interfaces.tasks.infer_v2 import InferTask
from monailabel.interfaces.tasks.train import TrainTask

from lib.infers.mcdropout_seg import MCDropoutSegmentation as MCDropoutInfer
from lib.infers.network import (
    build_spleen_unet,
    count_dropout_layers,
    load_verified_weights,
)
from lib.model_metadata import MODEL_CONFIG

logger = logging.getLogger(__name__)


class MCDropoutSeg(TaskConfig):
    """MC Dropout segmentation task config."""

    def init(self, name: str, model_dir: str, conf: Dict[str, str], planner: Any, **kwargs: Any) -> None:
        super().init(name, model_dir, conf, planner, **kwargs)

        self.labels = self._parse_labels(conf.get("labels", "spleen"))
        self.num_classes = len(self.labels) + 1
        self.num_samples = int(
            conf.get("mc_dropout_samples", str(MODEL_CONFIG.mc_samples))
        )
        self.dropout_rate = float(
            conf.get("dropout", str(MODEL_CONFIG.dropout_probability))
        )

        if self.dropout_rate <= 0:
            raise ValueError(
                f"MCDropoutSeg requires dropout > 0, got {self.dropout_rate}"
            )

        self.network = build_spleen_unet(dropout=self.dropout_rate)

        n_dropout = count_dropout_layers(self.network)
        logger.info(
            "MCDropoutSeg: built MONAI UNet with %d Dropout layers, T=%d, p=%.2f",
            n_dropout, self.num_samples, self.dropout_rate,
        )

        checkpoint_path = os.path.join(
            self.model_dir,
            "pretrained_segmentation.pt",
        )
        lock_path = os.path.join(self.model_dir, "checkpoint.lock.json")
        self.checkpoint_lock = load_verified_weights(
            self.network,
            Path(checkpoint_path),
            Path(lock_path),
        )
        self.path = None

        self.target_spacing = MODEL_CONFIG.target_spacing
        self.intensity_range = MODEL_CONFIG.intensity_range

    # ------------------------------------------------------------------

    def infer(self) -> Union[InferTask, Dict[str, InferTask]]:
        return {
            self.name: MCDropoutInfer(
                path=self.path,
                network=self.network,
                labels=self.labels,
                checkpoint_lock=self.checkpoint_lock,
                num_samples=self.num_samples,
                target_spacing=self.target_spacing,
                intensity_range=self.intensity_range,
                spatial_size=MODEL_CONFIG.roi_size,
                preload=False,
            )
        }

    def trainer(self) -> Optional[TrainTask]:
        return None  # weights come from the Segmentation task

    # ------------------------------------------------------------------

    @staticmethod
    def _parse_labels(spec: str) -> Dict[int, str]:
        names = [s.strip() for s in spec.split(",") if s.strip()]
        return {i + 1: name for i, name in enumerate(names)}
