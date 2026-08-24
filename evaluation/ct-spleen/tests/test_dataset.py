import hashlib
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import Any


MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from install_dataset import (  # noqa: E402
    MSD_SPLEEN_URL,
    SELECTED_FILES,
    _adopt_existing_partial,
    install_from_archive,
    read_dataset_lock,
    verify_installed_dataset,
)
from verify_orthanc_mapping import (  # noqa: E402
    load_case_mapping,
    validate_case_mapping,
)


EXPECTED_CASES = [
    (
        "patient001",
        "spleen_10",
        "imagesTr",
        True,
        "1.2.826.0.1.3680043.8.274.1.1.248825330.63900.8824652402.697",
        "1.2.826.0.1.3680043.8.274.1.1.784017185.94518.4538589876.211",
    ),
    (
        "patient002",
        "spleen_19",
        "imagesTr",
        True,
        "1.2.826.0.1.3680043.8.274.1.1.786988705.17387.8717949376.670",
        "1.2.826.0.1.3680043.8.274.1.1.217746236.48460.8396164103.990",
    ),
    (
        "patient003",
        "spleen_29",
        "imagesTr",
        True,
        "1.2.826.0.1.3680043.8.274.1.1.440932339.25736.8771857202.211",
        "1.2.826.0.1.3680043.8.274.1.1.323164088.69886.2011085890.421",
    ),
    (
        "patient004",
        "spleen_1",
        "imagesTs",
        False,
        "1.2.826.0.1.3680043.8.274.1.1.978964378.20833.5934797847.233",
        "1.2.826.0.1.3680043.8.274.1.1.435486677.64603.2847829754.141",
    ),
    (
        "patient005",
        "spleen_15",
        "imagesTs",
        False,
        "1.2.826.0.1.3680043.8.274.1.1.521426503.86857.9032450883.677",
        "1.2.826.0.1.3680043.8.274.1.1.956292836.56138.4474170934.471",
    ),
]

# Additional non-MSD cases in cases.json (detection cases, no reference mask,
# no MSD source file). Kept separate from EXPECTED_CASES so the archive
# fixtures above stay MSD-only.
EXPECTED_EXTRA_CASES = [
    (
        "DET0000101_avg",
        "imagesDET",
        False,
        "1.2.826.0.1.3680043.8.274.1.1.8247060327.75519.4237086139.796",
        "1.2.826.0.1.3680043.8.274.1.1.1549403409.92949.9928720754.350",
    ),
    (
        "DET0000201_avg",
        "imagesDET",
        False,
        "1.2.826.0.1.3680043.8.274.1.1.8274164626.27981.9346422741.638",
        "1.2.826.0.1.3680043.8.274.1.1.2202653464.10265.7141311830.759",
    ),
    (
        "DET0000801_avg",
        "imagesDET",
        False,
        "1.2.826.0.1.3680043.8.274.1.1.8040071758.33333.5872423995.676",
        "1.2.826.0.1.3680043.8.274.1.1.4147500540.47824.2955205109.117",
    ),
    (
        "DET0001101_avg",
        "imagesDET",
        False,
        "1.2.826.0.1.3680043.8.274.1.1.7013080792.45579.4320786143.942",
        "1.2.826.0.1.3680043.8.274.1.1.8117292811.77179.4669181639.866",
    ),
    (
        "DET0001201_avg",
        "imagesDET",
        False,
        "1.2.826.0.1.3680043.8.274.1.1.2511641213.49508.5941571327.745",
        "1.2.826.0.1.3680043.8.274.1.1.2951163338.77668.6902836753.453",
    ),
]


def fixture_archive(path: Path) -> None:
    with tarfile.open(path, "w") as archive:
        for _, msd_case, source_split, reference_available, _, _ in EXPECTED_CASES:
            entries = [(source_split, f"image:{msd_case}".encode())]
            if reference_available:
                entries.append(("labelsTr", f"label:{msd_case}".encode()))
            for folder, payload in entries:
                name = f"Task09_Spleen/{folder}/{msd_case}.nii.gz"
                info = tarfile.TarInfo(name=name)
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))


def lock_for_archive(archive: Path) -> dict:
    """Build the expected lock dict for a fixture archive (independent of the
    installer's own hashing, so the comparison is meaningful)."""
    files: dict[str, dict[str, Any]] = {}
    with tarfile.open(archive, "r:*") as handle:
        for member in handle.getmembers():
            parts = member.name.replace("\\", "/").lstrip("./").split("/")
            if len(parts) == 3 and parts[0] == "Task09_Spleen":
                folder, filename = parts[1], parts[2]
                if folder not in {"imagesTr", "imagesTs", "labelsTr"}:
                    continue
                payload = handle.extractfile(member).read()
                files[f"{folder}/{filename}"] = {
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "size_bytes": len(payload),
                }
    return {
        "dataset_id": "MSD-Task09-Spleen",
        "source_url": MSD_SPLEEN_URL,
        "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "archive_size_bytes": archive.stat().st_size,
        "files": dict(sorted(files.items())),
    }


class DatasetProvenanceTest(unittest.TestCase):
    def test_cases_json_has_exact_patient_study_series_and_msd_mapping(self):
        cases = load_case_mapping(MODULE_ROOT / "cases.json")

        self.assertEqual(
            [
                (
                    row["patient_id"],
                    row["msd_case"],
                    row["source_split"],
                    row["reference_available"],
                    row["study_uid"],
                    row["series_uid"],
                )
                for row in cases[:5]
            ],
            EXPECTED_CASES,
        )
        self.assertEqual(
            [
                (
                    row["patient_id"],
                    row["source_split"],
                    row["reference_available"],
                    row["study_uid"],
                    row["series_uid"],
                )
                for row in cases[5:]
            ],
            EXPECTED_EXTRA_CASES,
        )
        validate_case_mapping(cases)

    def test_rejects_duplicate_study_or_non_ct_mapping(self):
        cases = [
            {
                "patient_id": "patient001",
                "msd_case": "spleen_10",
                "study_uid": "study.1",
                "series_uid": "series.1",
                "modality": "CT",
            },
            {
                "patient_id": "patient002",
                "msd_case": "spleen_11",
                "study_uid": "study.1",
                "series_uid": "series.2",
                "modality": "MR",
            },
        ]

        with self.assertRaises(ValueError):
            validate_case_mapping(cases)

    def test_selective_install_writes_verified_archive_and_file_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "Task09_Spleen.tar"
            output = root / "data"
            lock_path = root / "dataset.lock.json"
            fixture_archive(archive)
            # The committed lock is the source of truth; the installer must
            # verify against it, not merely record what it downloaded.
            lock_path.write_text(
                json.dumps(lock_for_archive(archive), indent=2) + "\n",
                encoding="utf-8",
            )

            install_from_archive(
                archive,
                output,
                lock_path,
                source_url=MSD_SPLEEN_URL,
            )
            lock = read_dataset_lock(lock_path)

            self.assertEqual(
                lock["archive_sha256"],
                hashlib.sha256(archive.read_bytes()).hexdigest(),
            )
            self.assertEqual(len(lock["files"]), 8)
            for _, msd_case, source_split, reference_available, _, _ in EXPECTED_CASES:
                self.assertTrue(
                    (output / source_split / f"{msd_case}.nii.gz").exists()
                )
                self.assertEqual(
                    (output / "labelsTr" / f"{msd_case}.nii.gz").exists(),
                    reference_available,
                )

    def test_install_rejects_corrupted_archive(self):
        """Falsification check: a tampered archive must FAIL verification."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "Task09_Spleen.tar"
            output = root / "data"
            lock_path = root / "dataset.lock.json"
            fixture_archive(archive)
            lock_path.write_text(
                json.dumps(lock_for_archive(archive), indent=2) + "\n",
                encoding="utf-8",
            )

            # Corrupt the archive: append garbage bytes so the tar structure
            # still parses but the archive SHA-256 can no longer match.
            data = archive.read_bytes()
            archive.write_bytes(data + b"CORRUPTED-APPEND")

            with self.assertRaises(ValueError):
                install_from_archive(
                    archive,
                    output,
                    lock_path,
                    source_url=MSD_SPLEEN_URL,
                )

    def test_install_requires_committed_lock(self):
        """Without the committed lock there is nothing to verify against."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "Task09_Spleen.tar"
            output = root / "data"
            lock_path = root / "dataset.lock.json"
            fixture_archive(archive)

            with self.assertRaises(FileNotFoundError):
                install_from_archive(
                    archive,
                    output,
                    lock_path,
                    source_url=MSD_SPLEEN_URL,
                )

    def test_resume_adopts_legacy_randomly_named_partial(self):
        """Falsification check: resume must find legacy `-Task09_Spleen.tar.download`
        partials (random temp names from before the deterministic rename), not just
        the deterministic `.Task09_Spleen.tar.download` name."""
        with tempfile.TemporaryDirectory() as tmp:
            # Point gettempdir at an isolated dir for the duration of the check.
            original = tempfile.gettempdir
            tempfile.gettempdir = lambda: tmp
            try:
                legacy = Path(tmp) / ".tmplegacy-Task09_Spleen.tar.download"
                legacy.write_bytes(b"Z" * 2048)

                destination = Path(tmp) / "Task09_Spleen.tar"
                adopted = _adopt_existing_partial(destination)

                self.assertEqual(adopted.name, ".Task09_Spleen.tar.download")
                self.assertEqual(adopted.stat().st_size, 2048)
                self.assertFalse(legacy.exists(), "legacy partial should be renamed")
            finally:
                tempfile.gettempdir = original

    def test_resume_does_not_adopt_zero_byte_partial(self):
        """A zero-byte partial is not a resume candidate; download restarts."""
        with tempfile.TemporaryDirectory() as tmp:
            original = tempfile.gettempdir
            tempfile.gettempdir = lambda: tmp
            try:
                zero = Path(tmp) / ".tmpempty-Task09_Spleen.tar.download"
                zero.write_bytes(b"")

                destination = Path(tmp) / "Task09_Spleen.tar"
                adopted = _adopt_existing_partial(destination)

                self.assertEqual(adopted.name, ".Task09_Spleen.tar.download")
                self.assertFalse(adopted.exists())
                self.assertTrue(zero.exists(), "zero-byte partial left untouched")
            finally:
                tempfile.gettempdir = original

    def test_dataset_lock_rejects_missing_or_malformed_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "dataset.lock.json"
            lock_path.write_text(
                json.dumps(
                    {
                        "source_url": MSD_SPLEEN_URL,
                        "archive_sha256": "not-a-hash",
                        "files": {},
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaises(ValueError):
                read_dataset_lock(lock_path)

    def test_completed_install_is_verified_without_an_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "Task09_Spleen.tar"
            output = root / "data"
            lock_path = root / "dataset.lock.json"
            fixture_archive(archive)
            # Bootstrap a committed-style expected lock for this fixture.
            members = {}
            with tarfile.open(archive) as bundle:
                for member in bundle.getmembers():
                    if not member.isfile():
                        continue
                    relative = "/".join(member.name.replace("\\", "/").split("/")[-2:])
                    if relative not in SELECTED_FILES:
                        continue
                    payload = bundle.extractfile(member).read()
                    members[relative] = {
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "size_bytes": len(payload),
                    }
            lock_path.write_text(json.dumps({
                "dataset_id": "MSD-Task09-Spleen",
                "source_url": MSD_SPLEEN_URL,
                "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "archive_size_bytes": archive.stat().st_size,
                "installed_at": "fixture",
                "files": members,
            }), encoding="utf-8")
            install_from_archive(archive, output, lock_path, source_url=MSD_SPLEEN_URL)

            verified = verify_installed_dataset(output, lock_path)

            self.assertEqual(set(verified["files"]), set(SELECTED_FILES))


if __name__ == "__main__":
    unittest.main()
