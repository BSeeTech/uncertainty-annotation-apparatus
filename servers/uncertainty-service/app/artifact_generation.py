"""Transactional, condition-specific inference artifact generations."""

from __future__ import annotations

import json
import os
import shutil
import uuid
from pathlib import Path

from app.result_manifest import (
    ManifestValidationError,
    load_manifest,
    validate_manifest,
)


def condition_root(case_root: Path, condition: str) -> Path:
    if condition not in {"C1", "C2"}:
        raise ValueError(f"unsupported generation condition: {condition}")
    return case_root / condition


def current_generation_dir(case_root: Path, condition: str) -> Path | None:
    root = condition_root(case_root, condition)
    pointer_path = root / "current.json"
    if not pointer_path.is_file():
        return None
    try:
        pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
        generation = str(pointer["artifact_generation"])
        uuid.UUID(generation)
    except (OSError, json.JSONDecodeError, KeyError, ValueError) as exc:
        raise ManifestValidationError(
            f"invalid generation pointer: {pointer_path}"
        ) from exc
    generation_dir = root / "generations" / generation
    manifest = load_manifest(generation_dir / "result.json")
    validate_manifest(manifest, generation_dir)
    if manifest["condition"] != condition:
        raise ManifestValidationError(
            "current generation condition does not match pointer"
        )
    if manifest["artifact_generation"] != generation:
        raise ManifestValidationError(
            "current generation id does not match manifest"
        )
    return generation_dir


def publish_generation(
    case_root: Path,
    condition: str,
    staging_dir: Path,
) -> Path:
    manifest_path = staging_dir / "result.json"
    manifest = load_manifest(manifest_path)
    validate_manifest(manifest, staging_dir)
    if manifest["condition"] != condition:
        raise ManifestValidationError(
            "staging manifest condition does not match publication condition"
        )
    generation = str(manifest["artifact_generation"])
    try:
        uuid.UUID(generation)
    except ValueError as exc:
        raise ManifestValidationError(
            "artifact_generation must be a UUID"
        ) from exc

    root = condition_root(case_root, condition)
    generations = root / "generations"
    generations.mkdir(parents=True, exist_ok=True)
    destination = generations / generation
    if destination.exists():
        raise ManifestValidationError(
            f"generation already exists: {generation}"
        )

    # Staging is expected on the same output filesystem. os.replace gives an
    # atomic directory publication; the current pointer is switched only after
    # the complete destination validates.
    try:
        os.replace(staging_dir, destination)
    except OSError:
        shutil.copytree(staging_dir, destination)
        shutil.rmtree(staging_dir)

    try:
        published_manifest = load_manifest(destination / "result.json")
        validate_manifest(published_manifest, destination)
        pointer = root / "current.json"
        pointer_temp = root / f".current.{uuid.uuid4().hex}.tmp"
        pointer_temp.write_text(
            json.dumps(
                {"artifact_generation": generation},
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        os.replace(pointer_temp, pointer)
    except Exception:
        # A failed pointer update must leave the previous current generation
        # untouched. The complete but unreferenced generation is safe to remove.
        shutil.rmtree(destination, ignore_errors=True)
        raise
    return destination
