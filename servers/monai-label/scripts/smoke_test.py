"""Phase-1 smoke test.

Drives the ``MCDropoutSegmentation`` infer task directly (no HTTP server
required) on a small synthetic CT-like volume.  Verifies:

  1. The infer pipeline runs end-to-end without errors.
  2. The output segmentation has the same spatial extent as the input.
  3. The entropy volume has the same spatial extent and contains values
     in the expected range [0, ln(K)].
  4. Variability across the T forward passes is non-zero — i.e. dropout
     was actually active.  (If you swap in a network without dropout
     this assertion fails, which is the early-warning we want.)
  5. The writer produces both a segmentation NIfTI and an entropy NIfTI
     side-by-side.

Run::

    python scripts/smoke_test.py            # quick: T=4
    python scripts/smoke_test.py --samples 16   # configured sample count

Exit code 0 on success, non-zero on any failure.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

# Make the ``lib`` package importable when running from repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.checkpoint import CheckpointLock                              # noqa: E402
from lib.infers.mcdropout_seg import MCDropoutSegmentation, _enable_dropout  # noqa: E402
from lib.infers.network import count_dropout_layers                        # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s :: %(message)s")
log = logging.getLogger("smoke_test")

PLUMBING_CHECKPOINT = CheckpointLock(
    model_id="monailabel-radiology-spleen-unet",
    model_version="synthetic-plumbing-fixture",
    source_url=(
        "https://github.com/Project-MONAI/MONAILabel/releases/download/"
        "pretrained/radiology_segmentation_unet_spleen_total_seg.pt"
    ),
    sha256="0" * 64,
    size_bytes=1,
    modality="CT",
    anatomy="spleen",
    license="Apache-2.0",
)


class PlumbingNetwork(nn.Module):
    """Small stochastic network for software plumbing validation only."""

    def __init__(self):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Conv3d(1, 4, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Dropout3d(p=0.2),
            nn.Conv3d(4, 2, kernel_size=1),
        )

    def forward(self, inputs):
        return self.layers(inputs)


# ---------------------------------------------------------------------------
# Synthetic data
# ---------------------------------------------------------------------------


def make_synthetic_ct(
    shape=(96, 96, 64), spacing=(1.5, 1.5, 2.0), seed: int = 0
) -> tuple[str, np.ndarray]:
    """Write a small CT-like NIfTI to a temp file and return its path.

    The volume contains a rough soft-tissue background plus a single
    higher-intensity blob in the centre, so a randomly-initialised
    network produces spatially-varying outputs (which is what we need
    for the entropy assertion).
    """
    import nibabel as nib

    rng = np.random.default_rng(seed)
    vol = rng.normal(loc=40.0, scale=20.0, size=shape).astype(np.float32)
    # Insert a "lesion" with higher intensity
    cz, cy, cx = (s // 2 for s in shape)
    rz = ry = rx = 12
    zz, yy, xx = np.ogrid[:shape[0], :shape[1], :shape[2]]
    blob = ((zz - cz) / rz) ** 2 + ((yy - cy) / ry) ** 2 + ((xx - cx) / rx) ** 2 < 1.0
    vol[blob] += 120.0

    affine = np.diag([spacing[0], spacing[1], spacing[2], 1.0]).astype(np.float32)
    tmp = tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False)
    tmp.close()
    nib.save(nib.Nifti1Image(vol, affine), tmp.name)
    return tmp.name, vol


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=4,
                        help="Number of MC Dropout passes (use >=2)")
    parser.add_argument("--device", default="cpu",
                        help="cpu | cuda — defaults to cpu so the test runs anywhere")
    parser.add_argument("--keep-output", action="store_true",
                        help="Print and keep the output NIfTI files")
    args = parser.parse_args()

    if args.device == "cuda" and not torch.cuda.is_available():
        log.warning("CUDA requested but not available; falling back to CPU")
        args.device = "cpu"

    log.info("provenance_category=synthetic_plumbing_validation")
    log.info("Building small plumbing-only network (dropout=0.2)")
    network = PlumbingNetwork()
    n_dropout = count_dropout_layers(network)
    log.info("Network has %d Dropout layer(s)", n_dropout)
    assert n_dropout > 0, "Smoke test requires dropout layers in the network"

    log.info("Creating synthetic volume")
    img_path, vol = make_synthetic_ct()
    log.info("Wrote synthetic volume to %s, shape=%s", img_path, vol.shape)

    log.info("Constructing MCDropoutSegmentation infer task (T=%d)", args.samples)
    out_dir = tempfile.mkdtemp(prefix="smoke_out_")
    infer = MCDropoutSegmentation(
        path=None,                 # untrained — we just want the plumbing
        network=network,
        labels={1: "lesion"},
        checkpoint_lock=PLUMBING_CHECKPOINT,
        num_samples=args.samples,
        target_spacing=(1.5, 1.5, 2.0),
        intensity_range=(-175.0, 250.0),
        spatial_size=(64, 64, 64),
        preload=False,
        load_strict=False,
    )

    log.info("Running infer")
    request = {
        "image": img_path,
        "device": args.device,
        "output_dir": out_dir,
        "result_extension": ".nii.gz",
    }
    archive_path, result_json = infer(request)
    seg_path = result_json["segmentation"]
    log.info("archive path: %s", archive_path)
    log.info("seg path: %s", seg_path)
    log.info("result_json: %s", result_json)

    # ---------------- Assertions ----------------
    import nibabel as nib

    assert os.path.exists(seg_path), f"segmentation not written: {seg_path}"
    seg = nib.load(seg_path).get_fdata()
    log.info("Segmentation shape: %s, unique values: %s",
             seg.shape, np.unique(seg).tolist())

    ent_path = result_json.get("entropy") if isinstance(result_json, dict) else None
    if ent_path is None:
        # Fall back to the conventional sidecar location
        ent_path = seg_path.replace(".nii.gz", "_entropy.nii.gz")
    assert os.path.exists(ent_path), f"entropy sidecar not found: {ent_path}"

    ent = nib.load(ent_path).get_fdata()
    log.info("Entropy shape: %s, min=%.4f, max=%.4f, mean=%.4f",
             ent.shape, ent.min(), ent.max(), ent.mean())

    assert ent.shape == seg.shape, (
        f"entropy/seg shape mismatch: {ent.shape} vs {seg.shape}"
    )
    assert ent.min() >= -1e-5, f"entropy has negative values: min={ent.min()}"
    log_K_max = float(np.log(2)) + 1e-3
    assert ent.max() <= log_K_max, (
        f"entropy exceeds ln(K)={log_K_max:.4f}: max={ent.max()}"
    )
    assert ent.max() > 0, (
        "entropy is uniformly zero — dropout was probably not active. "
        "Check that the network has nn.Dropout* layers and the run_inferer "
        "loop calls _enable_dropout."
    )
    probability_path = result_json.get("foreground_probability")
    assert probability_path and os.path.exists(probability_path)
    probability = nib.load(probability_path).get_fdata()
    assert probability.shape == seg.shape
    assert probability.min() >= 0
    assert probability.max() <= 1

    # Sanity: a re-run on the same input should differ slightly because
    # dropout is stochastic.  (Skip if T=1, which is invalid anyway.)
    if args.samples >= 2:
        log.info("Re-running to verify stochasticity")
        _, result_json2 = infer({**request, "output_dir": tempfile.mkdtemp()})
        ent2 = nib.load(
            result_json2["entropy"]
        ).get_fdata()
        diff = float(np.abs(ent - ent2).mean())
        log.info("Mean abs difference between two MC Dropout runs: %.6f", diff)
        # With T=4 on a fixed seed, the difference should be tiny but
        # strictly non-zero unless something is wrong.
        assert diff > 1e-6, "two MC runs are identical — dropout not stochastic?"

    log.info("=" * 60)
    log.info("SYNTHETIC PLUMBING VALIDATION PASSED")
    log.info("  seg: %s", seg_path)
    log.info("  entropy: %s", ent_path)
    log.info("=" * 60)

    if not args.keep_output:
        try:
            os.unlink(img_path)
        except OSError:
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
