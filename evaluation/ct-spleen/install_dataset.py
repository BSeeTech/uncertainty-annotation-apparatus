"""Verified selective installer for MSD Task09 Spleen cases 10-14."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tarfile
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MSD_SPLEEN_URL = (
    "https://msd-for-monai.s3-us-west-2.amazonaws.com/Task09_Spleen.tar"
)
SELECTED_FILES = frozenset(
    {
        "imagesTr/spleen_10.nii.gz",
        "imagesTr/spleen_19.nii.gz",
        "imagesTr/spleen_29.nii.gz",
        "imagesTs/spleen_1.nii.gz",
        "imagesTs/spleen_15.nii.gz",
        "labelsTr/spleen_10.nii.gz",
        "labelsTr/spleen_19.nii.gz",
        "labelsTr/spleen_29.nii.gz",
    }
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_hash(value: Any, label: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9a-f]{64}",
        value,
    ):
        raise ValueError(
            f"{label} must be 64 lowercase hexadecimal characters"
        )


def read_dataset_lock(path: Path) -> dict[str, Any]:
    values = json.loads(path.read_text(encoding="utf-8"))
    if values.get("source_url") != MSD_SPLEEN_URL:
        raise ValueError("dataset lock has an unexpected source URL")
    _validate_hash(values.get("archive_sha256"), "archive_sha256")
    files = values.get("files")
    if not isinstance(files, dict) or len(files) != len(SELECTED_FILES):
        raise ValueError(
            f"dataset lock must contain exactly {len(SELECTED_FILES)} files"
        )
    for filename, metadata in files.items():
        if not isinstance(filename, str) or not isinstance(metadata, dict):
            raise ValueError("dataset lock file entry is malformed")
        _validate_hash(metadata.get("sha256"), f"{filename}.sha256")
        if not isinstance(metadata.get("size_bytes"), int) or (
            metadata["size_bytes"] <= 0
        ):
            raise ValueError(f"{filename}.size_bytes must be positive")
    return values


def _selected_member(member_name: str) -> tuple[str, str] | None:
    normalized = member_name.replace("\\", "/").lstrip("./")
    parts = normalized.split("/")
    if len(parts) < 2:
        return None
    folder = parts[-2]
    filename = parts[-1]
    if folder not in {"imagesTr", "imagesTs", "labelsTr"}:
        return None
    if f"{folder}/{filename}" not in SELECTED_FILES:
        return None
    return folder, filename


def install_from_archive(
    archive_path: Path,
    output_dir: Path,
    lock_path: Path,
    *,
    source_url: str,
) -> dict[str, Any]:
    if source_url != MSD_SPLEEN_URL:
        raise ValueError("only the official MONAI-hosted MSD URL is allowed")
    output_dir.mkdir(parents=True, exist_ok=True)
    installed: dict[str, dict[str, Any]] = {}

    with tarfile.open(archive_path, "r:*") as archive:
        for member in archive.getmembers():
            selected = _selected_member(member.name)
            if selected is None:
                continue
            if not member.isfile():
                raise ValueError(f"selected archive entry is not a file: {member.name}")
            folder, filename = selected
            target_dir = output_dir / folder
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / filename
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"unable to extract {member.name}")
            temp = target.with_name(f".{target.name}.tmp")
            with source, temp.open("wb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp, target)
            relative = target.relative_to(output_dir).as_posix()
            installed[relative] = {
                "sha256": sha256_file(target),
                "size_bytes": target.stat().st_size,
            }

    expected = set(SELECTED_FILES)
    if set(installed) != expected:
        missing = sorted(expected - set(installed))
        raise ValueError(f"archive is missing required Task09 files: {missing}")

    lock = {
        "dataset_id": "MSD-Task09-Spleen",
        "source_url": source_url,
        "archive_sha256": sha256_file(archive_path),
        "archive_size_bytes": archive_path.stat().st_size,
        "installed_at": datetime.now(timezone.utc).isoformat(),
        "files": dict(sorted(installed.items())),
    }
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    temp_lock = lock_path.with_name(f".{lock_path.name}.tmp")
    temp_lock.write_text(
        json.dumps(lock, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temp_lock, lock_path)
    read_dataset_lock(lock_path)
    return lock


def download_archive(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(f".{destination.name}.download")
    request = urllib.request.Request(
        MSD_SPLEEN_URL,
        headers={"User-Agent": "medical-imaging-platform-dataset-installer"},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        with temp.open("wb") as output:
            while True:
                chunk = response.read(4 * 1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
    os.replace(temp, destination)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "data",
    )
    parser.add_argument(
        "--lock",
        type=Path,
        default=Path(__file__).resolve().parent / "dataset.lock.json",
    )
    parser.add_argument("--archive", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    archive = args.archive
    delete_archive = False
    if archive is None:
        handle = tempfile.NamedTemporaryFile(
            suffix="-Task09_Spleen.tar",
            delete=False,
        )
        handle.close()
        archive = Path(handle.name)
        delete_archive = True
        download_archive(archive)
    try:
        lock = install_from_archive(
            archive,
            args.output,
            args.lock,
            source_url=MSD_SPLEEN_URL,
        )
        print(f"archive_sha256={lock['archive_sha256']}")
        print(f"archive_size_bytes={lock['archive_size_bytes']}")
        print(f"installed_files={len(lock['files'])}")
        return 0
    finally:
        if delete_archive:
            archive.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
