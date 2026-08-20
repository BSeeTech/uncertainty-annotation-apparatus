"""MC Dropout segmentation infer task.

Runs T stochastic forward passes through a segmentation network with
dropout layers kept active at inference time, and returns:

  * a deterministic segmentation mask (argmax of the mean predictive
    distribution over the T samples), and
  * a voxel-level predictive-entropy volume in nats, on [0, ln(K)] where
    K is the number of output classes.

Reference: Gal & Ghahramani 2016 (MC Dropout); Kendall & Gal 2017
(decomposition of predictive uncertainty); Mehrtash et al. 2020
(MC Dropout for medical image segmentation).

Design notes
------------
* The network must contain at least one ``nn.Dropout``, ``nn.Dropout2d``,
  or ``nn.Dropout3d`` module on the path from input to output.  After
  ``model.eval()`` we explicitly re-enable just those layers via
  ``_enable_dropout`` — BatchNorm stays in eval mode (using running stats)
  which is the correct behaviour: only dropout should be stochastic.
* This is a binary spleen model, so we accumulate only the foreground
  probability in float32. This preserves the segmentation, probability, and
  entropy contract while avoiding multiple full-resolution two-channel
  tensors on thin-slice CT volumes.
* The stochastic loop is the only place we deviate from MONAI Label's
  standard ``BasicInferTask`` flow.  Once ``run_inferer`` produces the
  averaged-softmax tensor, the rest of the post-transform pipeline runs
  unchanged: argmax, spatial inversion, and writer.
* The entropy volume is attached to the data dict under ``pred_entropy``
  as a ``MetaTensor`` carrying the same metadata as the input image, so
  the ``Restored`` transform can put it back into the original image
  geometry alongside the segmentation.
"""
from __future__ import annotations

import logging
import json
import os
import tempfile
import zipfile
from typing import Any, Callable, Dict, Optional, Sequence, Union

import numpy as np
import torch
import torch.nn as nn

from monai.data import MetaTensor
from monai.inferers import Inferer, SlidingWindowInferer
from monai.transforms import (
    Activationsd,
    AsDiscreted,
    Compose,
    EnsureChannelFirstd,
    EnsureTyped,
    Invertd,
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

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DROPOUT_TYPES = (nn.Dropout, nn.Dropout1d, nn.Dropout2d, nn.Dropout3d)


def _enable_dropout(model: nn.Module) -> int:
    """Set every dropout module to ``train()`` while leaving the rest of the
    network (notably BatchNorm) in eval mode.

    Returns the number of dropout modules that were re-enabled.  A return
    value of zero means the network has no dropout layers — MC Dropout
    will then collapse to a deterministic prediction, which is almost
    certainly a configuration mistake; the caller should warn or raise.
    """
    n = 0
    for module in model.modules():
        if isinstance(module, _DROPOUT_TYPES):
            module.train()
            n += 1
    return n


# ---------------------------------------------------------------------------
# Infer task
# ---------------------------------------------------------------------------


class MCDropoutSegmentation(BasicInferTask):
    """Segmentation infer with Monte-Carlo Dropout uncertainty.

    Parameters
    ----------
    path :
        Path(s) to the model checkpoint (passed through to BasicInferTask).
    network :
        A torch ``nn.Module`` whose forward signature matches the inferer.
        Must contain dropout layers for the uncertainty estimate to be
        non-trivial.
    labels :
        Mapping ``{class_index: class_name}`` for the foreground classes.
    num_samples :
        Number of stochastic forward passes T. This application uses T=16
        consistently for checkpoint-backed C2 inference.
    target_spacing :
        Resampling target in mm.  Defaults match common abdominal CT
        protocols; override per dataset.
    intensity_range :
        ``(a_min, a_max)`` for ``ScaleIntensityRanged``.  Defaults to a
        spleen CT soft-tissue window.
    spatial_size :
        Sliding-window ROI size.
    description :
        Human-readable label for the MONAI Label ``/info`` endpoint.
    """

    def __init__(
        self,
        path: Union[None, str, Sequence[str]],
        network: Optional[Callable] = None,
        labels: Optional[Dict[int, str]] = None,
        checkpoint_lock: Optional[CheckpointLock] = None,
        num_samples: int = MODEL_CONFIG.mc_samples,
        target_spacing: Sequence[float] = MODEL_CONFIG.target_spacing,
        intensity_range: Sequence[float] = MODEL_CONFIG.intensity_range,
        spatial_size: Sequence[int] = MODEL_CONFIG.roi_size,
        description: str = "MC Dropout segmentation with predictive entropy",
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
        if num_samples < 2:
            raise ValueError(f"num_samples must be >= 2 for MC Dropout, got {num_samples}")

        self.num_samples = int(num_samples)
        self.target_spacing = tuple(target_spacing)
        self.intensity_range = tuple(intensity_range)
        self.spatial_size = tuple(spatial_size)
        if checkpoint_lock is None:
            raise ValueError("checkpoint_lock is required")
        self.checkpoint_lock = checkpoint_lock

    # ------------------------------------------------------------------
    # Pre / post / inferer
    # ------------------------------------------------------------------

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
        # The "pred" tensor coming out of run_inferer is already a softmax
        # probability map (we computed the mean over T stochastic passes).
        # We therefore skip Activationsd and go straight to argmax.
        return [
            EnsureTyped(
                keys=("pred", "pred_entropy", "pred_probability")
            ),
            AsDiscreted(keys="pred", threshold=0.5),
            KeepLargestConnectedComponentd(keys="pred"),
            Restored(keys="pred", ref_image="image"),
            Restored(keys="pred_entropy", ref_image="image", mode="bilinear"),
            Restored(
                keys="pred_probability",
                ref_image="image",
                mode="bilinear",
            ),
        ]

    # ------------------------------------------------------------------
    # The MC Dropout loop
    # ------------------------------------------------------------------

    def run_inferer(  # type: ignore[override]
        self,
        data: Dict[str, Any],
        convert_to_batch: bool = True,
        device: str = "cuda",
    ) -> Dict[str, Any]:
        """Override of BasicInferTask.run_inferer.

        Performs T stochastic forward passes with dropout active and writes
        the mean softmax probabilities to ``data["pred"]`` plus the
        predictive entropy to ``data["pred_entropy"]``.
        """
        network = self._get_network(device, data)
        if network is None:
            raise RuntimeError("MCDropoutSegmentation: network is not loaded")

        # Set BatchNorm/etc. to eval, then re-enable only Dropout.
        network.eval()
        n_dropout = _enable_dropout(network)
        if n_dropout == 0:
            raise ValueError(
                "MCDropoutSegmentation: the network contains no Dropout layers; "
                "MC sampling would return T identical predictions -- zero "
                "entropy everywhere, every case routed to the lowest score "
                "band, and no signal in the output a reviewer could use to "
                "tell the run apart from a genuinely low-uncertainty case. "
                "Configure the network with a non-zero dropout rate."
            )

        inferer_obj = self.inferer(data)

        inputs = data[self.input_key]
        if not isinstance(inputs, torch.Tensor):
            inputs = torch.as_tensor(inputs)
        inputs = inputs.to(device)
        if convert_to_batch and inputs.ndim == self.dimension + 1:
            inputs = inputs.unsqueeze(0)

        # One foreground-channel accumulator is sufficient for this binary
        # checkpoint and substantially lowers peak memory on thin-slice CT.
        foreground_sum: Optional[torch.Tensor] = None

        with torch.no_grad():
            for _ in range(self.num_samples):
                # Select the foreground probability per ROI before MONAI
                # stitches the sliding-window output. For a binary model this
                # is mathematically equivalent to stitching both softmax
                # channels, while halving the dominant full-volume buffer.
                foreground = inferer_obj(
                    inputs,
                    lambda patch: torch.softmax(
                        network(patch),
                        dim=1,
                    )[:, 1:2],
                ).float()
                if foreground_sum is None:
                    foreground_sum = torch.zeros_like(foreground)
                foreground_sum.add_(foreground)

        assert foreground_sum is not None
        mean_foreground = foreground_sum / self.num_samples

        # Binary predictive entropy H([1-p, p]) in nats.
        eps = 1e-8
        background = 1.0 - mean_foreground
        entropy = -(
            mean_foreground * (mean_foreground + eps).log()
            + background * (background + eps).log()
        )

        # Drop the batch dim — MONAI Label expects (C, X, Y, Z).
        if convert_to_batch:
            mean_foreground = mean_foreground.squeeze(0)
            entropy = entropy.squeeze(0)

        # Wrap in MetaTensor inheriting the input's spatial metadata so
        # that Restored() can map both volumes back to the original space.
        in_meta = data[self.input_key].meta if isinstance(data[self.input_key], MetaTensor) else None
        data[self.output_label_key] = (
            MetaTensor(
                mean_foreground.cpu(),
                meta=dict(in_meta) if in_meta else None,
            )
        )
        data["pred_entropy"] = (
            MetaTensor(entropy.cpu(), meta=dict(in_meta) if in_meta else None)
        )
        data["pred_probability"] = MetaTensor(
            mean_foreground.cpu(),
            meta=dict(in_meta) if in_meta else None,
        )
        data["runtime_metadata"] = runtime_metadata(
            self.checkpoint_lock,
            num_samples=self.num_samples,
        )
        return data

    # ------------------------------------------------------------------
    # Writer override: emit two NIfTI files instead of one
    # ------------------------------------------------------------------

    def writer(self, data: Dict[str, Any], extension: Optional[str] = None, dtype: Any = None):
        """Save the segmentation as usual, then save the entropy volume
        as a sibling NIfTI named ``<base>_entropy.nii.gz``.

        BasicInferTask.writer's return contract is ``(label_path, result_json)``.
        We extend ``result_json`` with the entropy file path so that the
        FastAPI workflow service in Phase 2 can pick it up.
        """
        seg_path, result_json = super().writer(data, extension=extension, dtype=dtype)

        ent_path = self._write_scalar_sidecar(
            data,
            key="pred_entropy",
            seg_path=seg_path,
            suffix="_entropy.nii.gz",
        )
        probability_path = self._write_scalar_sidecar(
            data,
            key="pred_probability",
            seg_path=seg_path,
            suffix="_probability.nii.gz",
        )
        result_json = (
            dict(result_json)
            if isinstance(result_json, dict)
            else {"label": result_json}
        )
        result_json.update(
            data.get("runtime_metadata")
            or runtime_metadata(
                self.checkpoint_lock,
                num_samples=self.num_samples,
            )
        )

        zip_path = tempfile.NamedTemporaryFile(
            suffix=".zip",
            delete=False,
        ).name
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as archive:
            archive.write(seg_path, arcname="segmentation.nii.gz")
            archive.write(ent_path, arcname="uncertainty.nii.gz")
            archive.write(
                probability_path,
                arcname="foreground_probability.nii.gz",
            )
            archive.writestr(
                "result.json",
                json.dumps(result_json, sort_keys=True, default=str),
            )
        result_json["segmentation"] = seg_path
        result_json["entropy"] = ent_path
        result_json["foreground_probability"] = probability_path
        result_json["bundle"] = zip_path
        return zip_path, result_json

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _write_scalar_sidecar(
        data: Dict[str, Any],
        *,
        key: str,
        seg_path: str,
        suffix: str,
    ) -> str:
        """Write a restored scalar volume beside the segmentation."""
        import nibabel as nib

        scalar = data.get(key)
        if scalar is None:
            raise RuntimeError(
                f"data[{key!r}] missing — run_inferer did not populate it"
            )

        scalar_np = (
            scalar.detach().cpu().numpy()
            if isinstance(scalar, torch.Tensor)
            else np.asarray(scalar)
        )
        # Drop singleton channel if present.
        if scalar_np.ndim == 4 and scalar_np.shape[0] == 1:
            scalar_np = scalar_np[0]
        scalar_np = scalar_np.astype(np.float32)

        # Resolve affine from the MetaTensor or fall back to identity.
        affine = np.eye(4, dtype=np.float32)
        if isinstance(scalar, MetaTensor) and scalar.affine is not None:
            affine = np.asarray(scalar.affine).astype(np.float32)

        if seg_path.endswith(".nii.gz"):
            scalar_path = seg_path[:-len(".nii.gz")] + suffix
        elif seg_path.endswith(".nii"):
            scalar_path = seg_path[:-len(".nii")] + suffix
        else:
            scalar_path = seg_path + suffix

        nib.save(nib.Nifti1Image(scalar_np, affine), scalar_path)
        logger.info(
            "Wrote %s sidecar to %s (shape=%s)",
            key,
            scalar_path,
            scalar_np.shape,
        )
        return scalar_path
