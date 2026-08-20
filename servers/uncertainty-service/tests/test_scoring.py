"""Tests for uncertainty scoring service.

Covers: foreground entropy, all-background, edge cases, band thresholds.
"""

import gzip
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.scoring import compute_uncertainty_scores, score_band


def nifti_bytes(values, datatype):
    header = bytearray(348)
    struct.pack_into("<i", header, 0, 348)
    n = len(values)
    struct.pack_into("<hhhh", header, 40, 3, n, 1, 1)
    struct.pack_into("<h", header, 70, datatype)
    n_bytes = n * (1 if datatype == 2 else 4)
    struct.pack_into("<h", header, 72, n_bytes * 8 // n)
    struct.pack_into("<f", header, 108, 348.0)
    header[344:348] = b"n+1\0"
    if datatype == 2:
        body = bytes(values)
    elif datatype == 16:
        body = struct.pack(f"<{n}f", *values)
    else:
        raise ValueError(datatype)
    return gzip.compress(bytes(header) + body)


class UncertaintyScoringTest(unittest.TestCase):
    def test_scores_entropy_over_segmentation_foreground(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seg = root / "segmentation.nii.gz"
            unc = root / "uncertainty.nii.gz"
            seg.write_bytes(nifti_bytes([0, 1, 1, 0], 2))
            unc.write_bytes(nifti_bytes([0.1, 0.6, 0.8, 0.2], 16))
            stats = compute_uncertainty_scores(seg, unc, threshold=0.5)
        self.assertAlmostEqual(stats["score"], 0.7)
        self.assertAlmostEqual(stats["score_p95"], 0.79)
        self.assertAlmostEqual(stats["score_fraction_above"], 1.0)
        self.assertAlmostEqual(stats["score_mean_all"], 0.425)
        self.assertEqual(stats["band"], "high")

    def test_all_background_returns_zero_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seg = root / "segmentation.nii.gz"
            unc = root / "uncertainty.nii.gz"
            seg.write_bytes(nifti_bytes([0, 0, 0, 0], 2))
            unc.write_bytes(nifti_bytes([0.1, 0.2, 0.3, 0.4], 16))
            stats = compute_uncertainty_scores(seg, unc, threshold=0.5)
        self.assertEqual(stats["score"], 0.0)
        self.assertAlmostEqual(stats["score_mean_all"], 0.25)

    def test_single_foreground_voxel(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seg = root / "segmentation.nii.gz"
            unc = root / "uncertainty.nii.gz"
            seg.write_bytes(nifti_bytes([0, 1, 0, 0], 2))
            unc.write_bytes(nifti_bytes([0.1, 0.42, 0.3, 0.4], 16))
            stats = compute_uncertainty_scores(seg, unc, threshold=0.5)
        self.assertAlmostEqual(stats["score"], 0.42)
        self.assertAlmostEqual(stats["score_fraction_above"], 0.0)

    def test_constant_foreground_entropy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seg = root / "segmentation.nii.gz"
            unc = root / "uncertainty.nii.gz"
            seg.write_bytes(nifti_bytes([0, 1, 1, 1], 2))
            unc.write_bytes(nifti_bytes([0.3, 0.5, 0.5, 0.5], 16))
            stats = compute_uncertainty_scores(seg, unc, threshold=0.5)
        self.assertAlmostEqual(stats["score"], 0.5)
        self.assertAlmostEqual(stats["score_p95"], 0.5)
        self.assertAlmostEqual(stats["score_fraction_above"], 0.0)

    def test_all_foreground_voxels_above_threshold(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seg = root / "segmentation.nii.gz"
            unc = root / "uncertainty.nii.gz"
            seg.write_bytes(nifti_bytes([1, 1, 1, 1], 2))
            unc.write_bytes(nifti_bytes([0.6, 0.7, 0.8, 0.9], 16))
            stats = compute_uncertainty_scores(seg, unc, threshold=0.5)
        self.assertAlmostEqual(stats["score_fraction_above"], 1.0)
        self.assertEqual(stats["band"], "high")

    def test_empty_segmentation_returns_zero_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seg = root / "segmentation.nii.gz"
            unc = root / "uncertainty.nii.gz"
            # Create a valid single-voxel empty segmentation
            header = bytearray(348)
            struct.pack_into("<i", header, 0, 348)
            struct.pack_into("<hhhh", header, 40, 3, 1, 1, 1)
            struct.pack_into("<h", header, 70, 2)  # uint8
            struct.pack_into("<h", header, 72, 8)
            struct.pack_into("<f", header, 108, 348.0)
            header[344:348] = b"n+1\0"
            seg.write_bytes(gzip.compress(bytes(header) + b"\x00"))
            unc.write_bytes(nifti_bytes([0.5], 16))
            stats = compute_uncertainty_scores(seg, unc, threshold=0.5)
        self.assertEqual(stats["score"], 0.0)


class ScoreBandHelperTest(unittest.TestCase):
    """score_band helper tests."""

    def test_low_band_below_med_threshold(self):
        self.assertEqual(score_band(0.05), "low")

    def test_medium_band_between_thresholds(self):
        self.assertEqual(score_band(0.25), "medium")

    def test_high_band_above_high_threshold(self):
        self.assertEqual(score_band(0.55), "high")


class NiftiFileNotFoundTest(unittest.TestCase):
    def test_missing_segmentation_file_returns_zero_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seg = root / "nonexistent.nii.gz"
            unc = root / "uncertainty.nii.gz"
            unc.write_bytes(nifti_bytes([0.1, 0.2], 16))
            stats = compute_uncertainty_scores(seg, unc, threshold=0.5)
        self.assertEqual(stats["score"], 0.0)


if __name__ == "__main__":
    unittest.main()
