"""Verified selective installer for MSD Task09 Spleen cases 10-14."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tarfile
import tempfile
import time
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
    if not lock_path.exists():
        raise FileNotFoundError(
            f"expected lock file not found: {lock_path} — cannot verify the "
            "download without the committed SHA-256 reference"
        )
    # The committed lock is the source of truth; read it BEFORE overwriting.
    expected = read_dataset_lock(lock_path)
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

    expected_files = set(SELECTED_FILES)
    if set(installed) != expected_files:
        missing = sorted(expected_files - set(installed))
        raise ValueError(f"archive is missing required Task09 files: {missing}")

    archive_sha256 = sha256_file(archive_path)
    archive_size = archive_path.stat().st_size

    # Real verification: compare computed values against the committed lock.
    if archive_sha256 != expected["archive_sha256"]:
        raise ValueError(
            f"archive SHA-256 mismatch: got {archive_sha256}, "
            f"expected {expected['archive_sha256']}"
        )
    if archive_size != expected["archive_size_bytes"]:
        raise ValueError(
            f"archive size mismatch: got {archive_size} bytes, "
            f"expected {expected['archive_size_bytes']}"
        )
    for relative, metadata in installed.items():
        reference = expected["files"].get(relative)
        if reference is None:
            raise ValueError(f"lock file has no entry for {relative}")
        if metadata["sha256"] != reference["sha256"]:
            raise ValueError(
                f"SHA-256 mismatch for {relative}: got {metadata['sha256']}, "
                f"expected {reference['sha256']}"
            )
        if metadata["size_bytes"] != reference["size_bytes"]:
            raise ValueError(
                f"size mismatch for {relative}: got {metadata['size_bytes']} "
                f"bytes, expected {reference['size_bytes']}"
            )

    lock = {
        "dataset_id": "MSD-Task09-Spleen",
        "source_url": source_url,
        "archive_sha256": archive_sha256,
        "archive_size_bytes": archive_size,
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


def _expected_archive_size() -> int:
    """Expected archive size in bytes, read from the committed lock file."""
    lock_path = Path(__file__).resolve().parent / "dataset.lock.json"
    return read_dataset_lock(lock_path)["archive_size_bytes"]


_progress_state = {"last_report": 0.0}


def _report_progress(downloaded: int, expected: int, elapsed: float) -> None:
    """Print a single updating progress line (throttled to ~1 Hz)."""
    now = time.monotonic()
    if downloaded < expected and now - _progress_state["last_report"] < 1.0:
        return
    _progress_state["last_report"] = now
    percent = 100.0 * downloaded / expected
    speed = downloaded / elapsed if elapsed > 0 else 0.0
    remaining = expected - downloaded
    eta_min = remaining / speed / 60.0 if speed > 0 else float("inf")
    eta_text = "n/a" if eta_min == float("inf") else f"{eta_min:.1f} min"
    line = (
        f"\r  {downloaded / 1e6:8.1f} / {expected / 1e6:.0f} MB "
        f"({percent:5.1f}%)  {speed / 1e6:.2f} MB/s  ETA {eta_text}"
    )
    print(line, end="", flush=True)
    if downloaded >= expected:
        print()


def _adopt_existing_partial(destination: Path) -> Path:
    """Return the download temp path, resuming any existing partial download.

    Uses a deterministic temp name so re-runs continue where a previous
    interrupted run stopped instead of downloading the archive again. Also
    scans the temp dir for older randomly-named partials (e.g. from a run
    started before this feature) and adopts the largest one.
    """
    temp = destination.with_name(f".{destination.name}.download")
    if temp.exists() and temp.stat().st_size > 0:
        print(f"  Resuming existing partial download ({temp.stat().st_size / 1e6:.1f} MB).")
        return temp
    candidates = sorted(
        Path(tempfile.gettempdir()).glob("*Task09_Spleen.tar.download"),
        key=lambda p: p.stat().st_size,
        reverse=True,
    )
    for candidate in candidates:
        if candidate.stat().st_size > 0:
            print(
                f"  Adopting partial download {candidate.name} "
                f"({candidate.stat().st_size / 1e6:.1f} MB) for resume."
            )
            candidate.replace(temp)
            return temp
    return temp


def download_archive(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected = _expected_archive_size()
    temp = _adopt_existing_partial(destination)
    existing = temp.stat().st_size if temp.exists() else 0

    headers = {"User-Agent": "medical-imaging-platform-dataset-installer"}
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"
    request = urllib.request.Request(MSD_SPLEEN_URL, headers=headers)

    print(
        f"Downloading MSD Task09 Spleen archive ({expected / 1e6:.0f} MB) "
        f"from {MSD_SPLEEN_URL}"
    )
    start = time.monotonic()
    downloaded = existing
    with urllib.request.urlopen(request, timeout=600) as response:
        status = getattr(response, "status", 200)
        if existing > 0 and status == 200:
            # Server ignored the Range header; restart from scratch.
            print("  Server did not honor resume; restarting download.")
            existing = 0
            downloaded = 0
            temp.unlink(missing_ok=True)
        mode = "ab" if existing > 0 else "wb"
        with temp.open(mode) as output:
            while True:
                chunk = response.read(4 * 1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                downloaded += len(chunk)
                _report_progress(downloaded, expected, time.monotonic() - start)
            output.flush()
            os.fsync(output.fileno())
    if downloaded != expected:
        raise RuntimeError(
            f"download incomplete: {downloaded} bytes, expected {expected}"
        )
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
        # Deterministic path so an interrupted download is resumed on re-run.
        archive = Path(tempfile.gettempdir()) / "Task09_Spleen.tar"
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
