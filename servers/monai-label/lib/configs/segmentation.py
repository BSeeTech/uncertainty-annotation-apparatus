"""TaskConfig for the deterministic segmentation baseline.

A MONAI Label app is composed of one or more ``TaskConfig`` objects, each
of which knows how to build:

  * its inference task (``infer()``),
  * its training task (``trainer()``, optional — None for inference-only),
  * its scoring strategies, etc.

This config wires the shared MONAI UNet network into the plain
``Segmentation`` infer task.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Union

from monailabel.interfaces.config import TaskConfig
from monailabel.interfaces.tasks.infer_v2 import InferTask
from monailabel.interfaces.tasks.train import TrainTask

from lib.infers.network import build_spleen_unet, load_verified_weights
from lib.model_metadata import MODEL_CONFIG
from lib.infers.segmentation import Segmentation as SegmentationInfer

logger = logging.getLogger(__name__)


class Segmentation(TaskConfig):
    """Configures the deterministic single-pass segmentation task.

    Default labels are spleen-like (single foreground class).  Override via
    ``conf`` keys ``labels`` and ``num_classes`` if you plug in a different
    dataset.
    """

    def init(self, name: str, model_dir: str, conf: Dict[str, str], planner: Any, **kwargs: Any) -> None:
        super().init(name, model_dir, conf, planner, **kwargs)

        self.labels = self._parse_labels(conf.get("labels", "spleen"))
        # Number of output channels = background (0) + foreground classes.
        self.num_classes = len(self.labels) + 1

        checkpoint_path = os.path.join(
            self.model_dir,
            "pretrained_segmentation.pt",
        )
        lock_path = os.path.join(self.model_dir, "checkpoint.lock.json")
        self.network = build_spleen_unet(dropout=0.0)
        self.checkpoint_lock = load_verified_weights(
            self.network,
            Path(checkpoint_path),
            Path(lock_path),
        )
        # The network is already strictly loaded. Passing no path prevents
        # BasicInferTask from silently falling back to permissive loading.
        self.path = None

        self.target_spacing = MODEL_CONFIG.target_spacing
        self.intensity_range = MODEL_CONFIG.intensity_range

    # ------------------------------------------------------------------

    def infer(self) -> Union[InferTask, Dict[str, InferTask]]:
        return {
            self.name: SegmentationInfer(
                path=self.path,
                network=self.network,
                labels=self.labels,
                checkpoint_lock=self.checkpoint_lock,
                target_spacing=self.target_spacing,
                intensity_range=self.intensity_range,
                spatial_size=MODEL_CONFIG.roi_size,
                preload=False,
            )
        }

    def trainer(self) -> Optional[TrainTask]:
        # Phase 1 ships inference only.  Add a trainer in Phase 1.5 if you
        # want to retrain inside the app rather than via an external script.
        return None

    # ------------------------------------------------------------------

    @staticmethod
    def _parse_labels(spec: str) -> Dict[int, str]:
        """Parse ``"spleen"`` or ``"spleen,liver,kidney"`` into
        ``{1: "spleen"}`` or ``{1: "spleen", 2: "liver", 3: "kidney"}``.
        """
        names = [s.strip() for s in spec.split(",") if s.strip()]
        return {i + 1: name for i, name in enumerate(names)}
