"""MONAI Label app entrypoint.

Registers two task configs:

  * ``segmentation`` — deterministic single-pass UNet (used as the
    inference backend for the C1 evaluation condition: AI pre-annotation
    without uncertainty).
  * ``mcdropout_seg`` — MC Dropout UNet (used for C2: AI pre-annotation
    *with* uncertainty).

Both configs reference the same checkpoint(s), so a single training run
provides the model for both.

To run locally::

    monailabel start_server \\
        --app /workspace/app \\
        --studies /workspace/data/dicom \\
        --conf models segmentation,mcdropout_seg
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Dict

from monailabel.interfaces.app import MONAILabelApp
from monailabel.interfaces.config import TaskConfig
from monailabel.interfaces.datastore import Datastore
from monailabel.utils.others.generic import strtobool

from lib.configs.segmentation import Segmentation
from lib.configs.mcdropout_seg import MCDropoutSeg

logger = logging.getLogger(__name__)


class UncertaintyApp(MONAILabelApp):
    """MONAI Label app for the Medical Imaging Platform."""

    def __init__(self, app_dir: str, studies: str, conf: Dict[str, str]) -> None:
        self.model_dir = os.path.join(app_dir, "model")
        os.makedirs(self.model_dir, exist_ok=True)

        configs: Dict[str, TaskConfig] = {}
        config_classes = {
            "segmentation": Segmentation,
            "mcdropout_seg": MCDropoutSeg,
        }

        # Honour the --conf models switch if the user passes one;
        # otherwise enable everything.
        models_arg = conf.get("models", "all").lower().strip()
        enabled = (
            list(config_classes.keys())
            if models_arg in ("all", "")
            else [m.strip() for m in models_arg.split(",") if m.strip()]
        )

        for name in enabled:
            cls = config_classes.get(name)
            if cls is None:
                raise ValueError(
                    f"Unknown model '{name}'. Available: {list(config_classes)}"
                )
            cfg = cls()
            cfg.init(
                name=name,
                model_dir=self.model_dir,
                conf=conf,
                planner=None,
            )
            configs[name] = cfg

        self._task_configs = configs

        super().__init__(
            app_dir=app_dir,
            studies=studies,
            conf=conf,
            name="UncertaintyApp",
            description=(
                "MONAI Label app for the Medical Imaging Platform: "
                "MC Dropout uncertainty estimation and Sobel saliency "
                "placebo inference tasks."
            ),
        )

    # ------------------------------------------------------------------
    # MONAI Label hooks
    # ------------------------------------------------------------------

    def init_infers(self):
        from lib.infers.saliency_placebo import SaliencyPlaceboInferTask

        infers = {}
        for cfg in self._task_configs.values():
            cfg_infers = cfg.infer()
            if cfg_infers is None:
                continue
            if isinstance(cfg_infers, dict):
                infers.update(cfg_infers)
            else:
                infers[cfg.name] = cfg_infers

        # C3 placebo-saliency: reuses the same checkpoint but replaces
        # the uncertainty map with a Sobel edge-magnitude overlay.
        # This is registered as a separate infer task so the uncertainty
        # service can request it explicitly for C3 cases.
        if "mcdropout_seg" in infers:
            checkpoint_path = Path(self.model_dir) / "pretrained_segmentation.pt"
            if not checkpoint_path.exists():
                logger.warning(
                    "C3 placebo-saliency task not registered — "
                    "checkpoint not found at %s",
                    checkpoint_path,
                )
            else:
                placebo = SaliencyPlaceboInferTask(
                    path=checkpoint_path,
                    conf={},
                )
                infers["saliency_placebo"] = placebo

        logger.info("Registered infers: %s", list(infers.keys()))
        return infers

    def init_trainers(self):
        # Phase 1: inference only.  Add trainers in a later phase if you
        # want training inside the app.
        return {}

    def init_strategies(self):
        # The worklist policy lives in the FastAPI uncertainty
        # service, not in MONAI Label's own active-learning
        # strategy hook, because the policy needs case-level scores
        # which MONAI Label does not natively produce.
        return {}

    def init_scoring_methods(self):
        return {}
