"""Authoritative metadata for the checkpoint-backed CT spleen model."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from importlib.metadata import PackageNotFoundError, version
from typing import Any

import torch

from lib.checkpoint import CheckpointLock


@dataclass(frozen=True)
class ModelConfig:
    model_id: str = "monailabel-radiology-spleen-unet"
    modality: str = "CT"
    anatomy: str = "spleen"
    mc_samples: int = 16
    dropout_probability: float = 0.2
    uncertainty_threshold: float = 0.50
    target_spacing: tuple[float, float, float] = (1.5, 1.5, 1.5)
    intensity_range: tuple[float, float] = (-57.0, 164.0)
    roi_size: tuple[int, int, int] = (96, 96, 96)


MODEL_CONFIG = ModelConfig()


def _package_version(package: str) -> str:
    try:
        return version(package)
    except PackageNotFoundError:
        return "unknown"


def runtime_metadata(
    checkpoint: CheckpointLock,
    *,
    num_samples: int,
    dropout_probability: float | None = None,
) -> dict[str, Any]:
    metadata = asdict(MODEL_CONFIG)
    metadata["mc_samples"] = num_samples
    if dropout_probability is not None:
        metadata["dropout_probability"] = dropout_probability
    return {
        **metadata,
        "model_version": checkpoint.model_version,
        "checkpoint_sha256": checkpoint.sha256,
        "checkpoint_size_bytes": checkpoint.size_bytes,
        "num_samples": num_samples,
        "entropy_units": "nats",
        "monai_version": _package_version("monai"),
        "monailabel_version": _package_version("monailabel"),
        "torch_version": torch.__version__,
    }
