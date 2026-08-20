"""Official MONAI Label spleen UNet construction and strict weight loading."""

from __future__ import annotations

from pathlib import Path

import torch
import torch.nn as nn
from monai.networks.nets import UNet

from lib.checkpoint import CheckpointLock, verify_checkpoint


_DROPOUT_TYPES = (
    nn.Dropout,
    nn.Dropout1d,
    nn.Dropout2d,
    nn.Dropout3d,
)


def build_spleen_unet(dropout: float = 0.0) -> nn.Module:
    return UNet(
        spatial_dims=3,
        in_channels=1,
        out_channels=2,
        channels=(16, 32, 64, 128, 256),
        strides=(2, 2, 2, 2),
        num_res_units=2,
        norm="batch",
        dropout=dropout,
    )


def count_dropout_layers(model: nn.Module) -> int:
    return sum(
        1
        for module in model.modules()
        if isinstance(module, _DROPOUT_TYPES)
    )


def learned_state_shapes(model: nn.Module) -> dict[str, tuple[int, ...]]:
    return {
        key: tuple(value.shape)
        for key, value in model.state_dict().items()
    }


def _checkpoint_state_dict(payload: object) -> dict[str, torch.Tensor]:
    if not isinstance(payload, dict):
        raise RuntimeError(
            "checkpoint strict loading requires a state-dict mapping"
        )
    for key in ("state_dict", "model"):
        candidate = payload.get(key)
        if isinstance(candidate, dict):
            payload = candidate
            break
    if not all(
        isinstance(key, str) and isinstance(value, torch.Tensor)
        for key, value in payload.items()
    ):
        raise RuntimeError(
            "checkpoint strict loading found non-tensor state entries"
        )
    return dict(payload)


def load_verified_weights(
    model: nn.Module,
    checkpoint_path: Path,
    lock_path: Path,
) -> CheckpointLock:
    lock = verify_checkpoint(checkpoint_path, lock_path)
    try:
        payload = torch.load(
            checkpoint_path,
            map_location="cpu",
            weights_only=True,
        )
    except TypeError:
        payload = torch.load(checkpoint_path, map_location="cpu")
    state_dict = _checkpoint_state_dict(payload)

    expected = model.state_dict()
    missing = sorted(set(expected) - set(state_dict))
    unexpected = sorted(set(state_dict) - set(expected))
    mismatched = sorted(
        key
        for key in set(expected).intersection(state_dict)
        if tuple(expected[key].shape) != tuple(state_dict[key].shape)
    )
    if missing or unexpected or mismatched:
        raise RuntimeError(
            "checkpoint strict loading failed: "
            f"missing={missing}, unexpected={unexpected}, "
            f"shape_mismatch={mismatched}"
        )

    model.load_state_dict(state_dict, strict=True)
    return lock
