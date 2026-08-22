"""Install and lock the official MONAI Label CT spleen checkpoint."""

from __future__ import annotations

import argparse
import os
import sys
import urllib.request
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib.checkpoint import (  # noqa: E402
    OFFICIAL_CHECKPOINT_URL,
    OFFICIAL_MODEL_ID,
    OFFICIAL_MODEL_VERSION,
    CheckpointIntegrityError,
    CheckpointLock,
    read_lock,
    sha256_file,
    verify_checkpoint,
    write_lock,
)


def download_checkpoint(destination: Path) -> None:
    request = urllib.request.Request(
        OFFICIAL_CHECKPOINT_URL,
        headers={"User-Agent": "medical-imaging-platform-checkpoint-installer"},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        with destination.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())


def install(checkpoint_path: Path, lock_path: Path) -> CheckpointLock:
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    download_path = checkpoint_path.with_name(".checkpoint.download")
    download_path.unlink(missing_ok=True)

    try:
        download_checkpoint(download_path)
        # Reject truncated or non-PyTorch payloads before publication.
        torch.load(download_path, map_location="cpu")
        measured = CheckpointLock(
            model_id=OFFICIAL_MODEL_ID,
            model_version=OFFICIAL_MODEL_VERSION,
            source_url=OFFICIAL_CHECKPOINT_URL,
            sha256=sha256_file(download_path),
            size_bytes=download_path.stat().st_size,
            modality="CT",
            anatomy="spleen",
            license="Apache-2.0",
        )

        if lock_path.exists():
            expected = read_lock(lock_path)
            if measured != expected:
                raise CheckpointIntegrityError(
                    "downloaded checkpoint does not match the committed lock"
                )

        os.replace(download_path, checkpoint_path)
        if not lock_path.exists():
            write_lock(lock_path, measured)
        return verify_checkpoint(checkpoint_path, lock_path)
    finally:
        download_path.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    # Anchor defaults to the script's directory so the documented invocation
    # "python servers/monai-label/scripts/install_checkpoint.py" from the repo
    # root writes to servers/monai-label/model/, which is what docker-compose
    # bind-mounts — not to ./model/ relative to the caller's CWD.
    script_dir = Path(__file__).resolve().parent.parent  # servers/monai-label
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=script_dir / "model" / "pretrained_segmentation.pt",
    )
    parser.add_argument(
        "--lock",
        type=Path,
        default=script_dir / "model" / "checkpoint.lock.json",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    verified = install(args.checkpoint, args.lock)
    print(f"checkpoint={args.checkpoint}")
    print(f"version={verified.model_version}")
    print(f"sha256={verified.sha256}")
    print(f"size_bytes={verified.size_bytes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
