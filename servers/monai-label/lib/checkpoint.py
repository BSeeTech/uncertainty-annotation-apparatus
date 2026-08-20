"""Verified checkpoint provenance for the CT spleen model."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path


OFFICIAL_CHECKPOINT_URL = (
    "https://github.com/Project-MONAI/MONAILabel/releases/download/pretrained/"
    "radiology_segmentation_unet_spleen_total_seg.pt"
)
OFFICIAL_MODEL_ID = "monailabel-radiology-spleen-unet"
OFFICIAL_MODEL_VERSION = (
    "pretrained/radiology_segmentation_unet_spleen_total_seg.pt"
)


class CheckpointIntegrityError(RuntimeError):
    """Raised when checkpoint provenance or bytes do not match the lock."""


@dataclass(frozen=True)
class CheckpointLock:
    model_id: str
    model_version: str
    source_url: str
    sha256: str
    size_bytes: int
    modality: str
    anatomy: str
    license: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_lock(lock: CheckpointLock) -> None:
    if lock.model_id != OFFICIAL_MODEL_ID:
        raise CheckpointIntegrityError(
            f"unexpected model id: {lock.model_id}"
        )
    if lock.model_version != OFFICIAL_MODEL_VERSION:
        raise CheckpointIntegrityError(
            f"unexpected model version: {lock.model_version}"
        )
    if lock.source_url != OFFICIAL_CHECKPOINT_URL:
        raise CheckpointIntegrityError(
            f"checkpoint source is not the official MONAI asset: {lock.source_url}"
        )
    if not re.fullmatch(r"[0-9a-f]{64}", lock.sha256):
        raise CheckpointIntegrityError(
            "SHA-256 must be 64 lowercase hexadecimal characters"
        )
    if lock.size_bytes <= 0:
        raise CheckpointIntegrityError("checkpoint size must be positive")
    if lock.modality != "CT":
        raise CheckpointIntegrityError(
            f"checkpoint modality must be CT, got {lock.modality}"
        )
    if lock.anatomy != "spleen":
        raise CheckpointIntegrityError(
            f"checkpoint anatomy must be spleen, got {lock.anatomy}"
        )
    if lock.license != "Apache-2.0":
        raise CheckpointIntegrityError(
            f"checkpoint license must be Apache-2.0, got {lock.license}"
        )


def read_lock(path: Path) -> CheckpointLock:
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
        lock = CheckpointLock(**values)
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise CheckpointIntegrityError(
            f"unable to read checkpoint lock: {path}"
        ) from exc
    validate_lock(lock)
    return lock


def write_lock(path: Path, lock: CheckpointLock) -> None:
    validate_lock(lock)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_text(
        json.dumps(asdict(lock), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temp, path)


def verify_checkpoint(
    checkpoint_path: Path,
    lock_path: Path,
) -> CheckpointLock:
    if not checkpoint_path.is_file():
        raise CheckpointIntegrityError(
            f"checkpoint missing: {checkpoint_path}"
        )
    lock = read_lock(lock_path)
    measured_size = checkpoint_path.stat().st_size
    if measured_size != lock.size_bytes:
        raise CheckpointIntegrityError(
            "checkpoint byte size does not match lock: "
            f"{measured_size} != {lock.size_bytes}"
        )
    measured_hash = sha256_file(checkpoint_path)
    if measured_hash != lock.sha256:
        raise CheckpointIntegrityError(
            "checkpoint SHA-256 does not match lock: "
            f"{measured_hash} != {lock.sha256}"
        )
    return lock
