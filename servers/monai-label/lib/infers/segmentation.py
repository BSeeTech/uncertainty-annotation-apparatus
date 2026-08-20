"""Plain (deterministic) segmentation infer task.

This is the baseline used for the C1 evaluation condition: AI pre-annotation
*without* any uncertainty information.  It shares the same network and
pre/post-transforms as the MC Dropout task so that any difference in
annotation quality between C1 and C2 can be attributed to the uncertainty
display rather than to a different model.
"""
from __future__ import annotations

import json
import os
import tempfile
import zipfile
from typing import Any, Callable, Dict, Optional, Sequence, Union

from monai.inferers import Inferer, SlidingWindowInferer
from monai.transforms import (
    Activationsd,
    AsDiscreted,
    EnsureChannelFirstd,
    EnsureTyped,
    KeepLargestConnectedComponentd,
    LoadImaged,
    Orientationd,
    ScaleIntensityd,
    ScaleIntensityRanged,
    Spacingd,
)
from monailabel.interfaces.tasks.infer_v2 import InferType
from monailabel.tasks.infer.basic_infer import BasicInferTask
from monailabel.transform.post import Restored

from lib.checkpoint import CheckpointLock
from lib.model_metadata import MODEL_CONFIG, runtime_metadata


class Segmentation(BasicInferTask):
    """Deterministic (single forward-pass) segmentation."""

    def __init__(
        self,
        path: Union[None, str, Sequence[str]],
        network: Optional[Callable] = None,
        labels: Optional[Dict[int, str]] = None,
        checkpoint_lock: Optional[CheckpointLock] = None,
        target_spacing: Sequence[float] = MODEL_CONFIG.target_spacing,
        intensity_range: Sequence[float] = MODEL_CONFIG.intensity_range,
        spatial_size: Sequence[int] = MODEL_CONFIG.roi_size,
        description: str = "Deterministic segmentation (baseline, no uncertainty)",
        **kwargs: Any,
    ) -> None:
        super().__init__(
            path=path,
            network=network,
            type=InferType.SEGMENTATION,
            labels=labels,
            dimension=3,
            description=description,
            **kwargs,
        )
        self.target_spacing = tuple(target_spacing)
        self.intensity_range = tuple(intensity_range)
        self.spatial_size = tuple(spatial_size)
        if checkpoint_lock is None:
            raise ValueError("checkpoint_lock is required")
        self.checkpoint_lock = checkpoint_lock

    def pre_transforms(self, data: Optional[Dict[str, Any]] = None) -> Sequence:
        return [
            LoadImaged(keys="image", reader="ITKReader"),
            EnsureChannelFirstd(keys="image"),
            Orientationd(keys="image", axcodes="RAS"),
            Spacingd(keys="image", pixdim=self.target_spacing, mode="bilinear"),
            ScaleIntensityRanged(
                keys="image",
                a_min=self.intensity_range[0],
                a_max=self.intensity_range[1],
                b_min=0.0,
                b_max=1.0,
                clip=True,
            ),
            ScaleIntensityd(keys="image", minv=-1.0, maxv=1.0),
            EnsureTyped(keys="image"),
        ]

    def inferer(self, data: Optional[Dict[str, Any]] = None) -> Inferer:
        return SlidingWindowInferer(
            roi_size=self.spatial_size,
            sw_batch_size=1,
            overlap=0.25,
            mode="gaussian",
        )

    def post_transforms(self, data: Optional[Dict[str, Any]] = None) -> Sequence:
        return [
            EnsureTyped(keys="pred"),
            Activationsd(keys="pred", softmax=True),
            AsDiscreted(keys="pred", argmax=True),
            KeepLargestConnectedComponentd(keys="pred"),
            Restored(keys="pred", ref_image="image"),
        ]

    def writer(
        self,
        data: Dict[str, Any],
        extension: Optional[str] = None,
        dtype: Any = None,
    ):
        segmentation_path, result = super().writer(
            data,
            extension=extension,
            dtype=dtype,
        )
        result_json = dict(result) if isinstance(result, dict) else {}
        result_json.update(
            runtime_metadata(
                self.checkpoint_lock,
                num_samples=1,
                dropout_probability=0.0,
            )
        )
        archive_path = tempfile.NamedTemporaryFile(
            suffix=".zip",
            delete=False,
        ).name
        with zipfile.ZipFile(
            archive_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as archive:
            archive.write(
                segmentation_path,
                arcname="segmentation.nii.gz",
            )
            archive.writestr(
                "result.json",
                json.dumps(result_json, sort_keys=True, default=str),
            )
        result_json["segmentation"] = segmentation_path
        result_json["bundle"] = archive_path
        return archive_path, result_json
