"""C3 placebo-saliency inference: edge-magnitude overlay instead of uncertainty.

This task produces an identically-formatted NIfTI bundle as the MC Dropout
inference (segmentation.nii.gz + uncertainty.nii.gz + foreground_probability.nii.gz
+ result.json), but the "uncertainty" map is computed as a Sobel edge magnitude
from the predicted segmentation.  This provides a saliency-matched placebo
control for the uncertainty heatmap condition (C2).

The edge-magnitude map is:
  - Normalised to [0, max_value] to match the entropy range
  - Smooth (Gaussian-blurred before Sobel) so it does not look like a cheap edge overlay
  - Always non-zero at predicted organ boundaries (where entropy also peaks)
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from typing import Any, Dict, Optional, Sequence

import numpy as np
import torch
from monai.transforms import (
    EnsureChannelFirstd,
    EnsureTyped,
    LoadImaged,
    Orientationd,
    ScaleIntensityd,
    ScaleIntensityRanged,
    Spacingd,
)
from monailabel.interfaces.tasks.infer import InferTask, InferType
from monailabel.tasks.infer.basic_infer import BasicInferTask
from scipy.ndimage import gaussian_filter, sobel

from lib.model_metadata import MODEL_CONFIG


class SaliencyPlaceboInferTask(BasicInferTask):
    """Inference task that replaces entropy with Sobel edge magnitude."""

    def __init__(self, path: Path, conf: dict[str, str] | None = None, **kwargs):
        super().__init__(
            path=str(path),
            network=None,  # reuse the same pre-loaded model
            type=InferType.SEGMENTATION,
            labels=None,
            dimension=3,
            description="Saliency placebo (Sobel edge magnitude overlay)",
            config=conf or {},
            **kwargs,
        )
        self._max_edge: float = 0.0  # tracked across slices for global normalisation

    def pre_transforms(self, data: Optional[Dict[str, Any]] = None) -> Sequence:
        return [
            LoadImaged(keys="image", reader="ITKReader"),
            EnsureChannelFirstd(keys="image"),
            Orientationd(keys="image", axcodes="RAS"),
            Spacingd(
                keys="image",
                pixdim=MODEL_CONFIG.target_spacing,
                mode="bilinear",
            ),
            ScaleIntensityRanged(
                keys="image",
                a_min=MODEL_CONFIG.intensity_range[0],
                a_max=MODEL_CONFIG.intensity_range[1],
                b_min=0.0,
                b_max=1.0,
                clip=True,
            ),
            ScaleIntensityd(keys="image", minv=-1.0, maxv=1.0),
            EnsureTyped(keys="image"),
        ]

    def post_transforms(self, data: Optional[Dict[str, Any]] = None) -> Sequence:
        # All post-processing is handled in writer() (softmax, argmax, Sobel edge
        # detection, NIfTI bundle assembly).  No additional transforms needed.
        return []

    def run_inferer(self, data: torch.Tensor, *args, **kwargs) -> torch.Tensor:
        """Forward pass — identical to C1 (single pass, deterministic)."""
        return self.model(data)

    def writer(self, data: dict, *args, **kwargs) -> list[dict]:
        """Write NIfTI bundle with Sobel edge magnitude as 'uncertainty' map."""
        pred_logits: torch.Tensor = data["pred"]  # (B, C, H, W, D)
        pred_softmax = torch.softmax(pred_logits, dim=1)

        # Foreground probability (class 1, assume binary segmentation)
        fg_prob: np.ndarray = pred_softmax[0, 1].cpu().numpy().astype(np.float32)

        # Predicted hard segmentation
        seg_hard: np.ndarray = pred_softmax.argmax(dim=1)[0].cpu().numpy().astype(np.uint8)

        # --- Sobel edge magnitude of the hard segmentation ---
        # Blur first so the edge map is smooth (not a thin line)
        blurred = gaussian_filter(seg_hard.astype(np.float32), sigma=1.5)
        edges = np.sqrt(
            sobel(blurred, axis=0) ** 2
            + sobel(blurred, axis=1) ** 2
            + sobel(blurred, axis=2) ** 2
        )
        # Normalise to [0, max_value] — match entropy's typical range (~0–4.5 nats)
        edge_max = edges.max()
        if edge_max > 1e-8:
            edges = edges / edge_max * 4.5
        self._max_edge = max(self._max_edge, float(edge_max))

        uncertainty_map = edges.astype(np.float32)

        # --- Bundle writing (identical format to MC Dropout task) ---
        import nibabel as nib

        output_dir = Path(kwargs.get("output_dir", "/tmp"))
        case_id = data.get("image_path", "unknown")
        affine = np.eye(4)

        nii_seg = nib.Nifti1Image(seg_hard, affine)
        nii_unc = nib.Nifti1Image(uncertainty_map, affine)
        nii_fg = nib.Nifti1Image(fg_prob, affine)

        buf_seg = io.BytesIO()
        buf_unc = io.BytesIO()
        buf_fg = io.BytesIO()
        nib.save(nii_seg, buf_seg)
        nib.save(nii_unc, buf_unc)
        nib.save(nii_fg, buf_fg)

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("segmentation.nii.gz", buf_seg.getvalue())
            zf.writestr("uncertainty.nii.gz", buf_unc.getvalue())
            zf.writestr("foreground_probability.nii.gz", buf_fg.getvalue())
            zf.writestr(
                "result.json",
                '{"condition": "C3", "method": "sobel-edge-saliency",'
                f' "max_edge": {self._max_edge:.4f}}}',
            )

        out_path = output_dir / f"{case_id}_C3.zip"
        with open(out_path, "wb") as f:
            f.write(zip_buffer.getvalue())

        return [{"path": str(out_path), "type": "application/zip"}]
