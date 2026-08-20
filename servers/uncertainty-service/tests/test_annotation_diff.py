"""Tests for annotation_diff service.

Verify the shape-checking and voxel-wise comparison logic.
Covers: diff_arrays, diff_files, shape mismatch, C0 branch, format support.

Total: 9 tests.
"""

import io
import unittest
from pathlib import Path

import numpy as np

# Ensure the app package is importable
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.annotation_diff import AnnotationDiff, diff_arrays, diff_files


def _make_nifti_bytes(data: np.ndarray) -> bytes:
    """Build a minimal NIfTI-1 byte buffer from a numpy array."""
    import struct

    dim = data.ndim
    shape = data.shape
    header = bytearray(348)
    # sizeof_hdr
    struct.pack_into("<i", header, 0, 348)
    # dim[0] = dimensionality, dim[1..dim] = shape
    struct.pack_into("<h", header, 40, dim)
    for i, s in enumerate(shape):
        struct.pack_into("<h", header, 42 + i * 2, s)
    # datatype = int16 (4)
    struct.pack_into("<h", header, 70, 4)
    # bitpix
    struct.pack_into("<h", header, 72, 16)
    # vox_offset = 352 (348 header + 4 extension bytes)
    struct.pack_into("<f", header, 108, 352.0)
    # magic = n+1\0 for .nii
    header[344:348] = b"n+1\x00"
    # 4 zero extension bytes after header
    return bytes(header) + b"\x00\x00\x00\x00" + data.astype(np.int16).tobytes()


class AnnotationDiffArraysTest(unittest.TestCase):
    """Pure-function tests for diff_arrays."""

    def test_identical_arrays_produce_zero_edit_count(self):
        reviewer = np.array([[0, 0, 0], [0, 1, 0], [0, 0, 0]], dtype=np.int16)
        ai = np.array([[0, 0, 0], [0, 1, 0], [0, 0, 0]], dtype=np.int16)
        result = diff_arrays(reviewer, ai)
        self.assertIsInstance(result, AnnotationDiff)
        self.assertEqual(result.edit_voxel_count, 0)
        self.assertEqual(result.ai_foreground_voxels, 1)
        self.assertEqual(result.edit_fraction_of_ai_foreground, 0.0)

    def test_completely_different_arrays_produce_full_edit_count(self):
        reviewer = np.ones((4, 4), dtype=np.int16)
        ai = np.zeros((4, 4), dtype=np.int16)
        result = diff_arrays(reviewer, ai)
        self.assertEqual(result.edit_voxel_count, 16)
        self.assertEqual(result.ai_foreground_voxels, 0)
        self.assertEqual(result.edit_fraction_of_ai_foreground, 0.0)

    def test_partial_edits_produce_correct_counts(self):
        reviewer = np.array([[1, 1, 0], [0, 0, 0], [0, 0, 0]], dtype=np.int16)
        ai = np.array([[1, 0, 0], [0, 0, 0], [0, 0, 0]], dtype=np.int16)
        result = diff_arrays(reviewer, ai)
        # reviewer has 2 foreground, ai has 1, diff = positions where != → 1
        self.assertEqual(result.edit_voxel_count, 1)
        self.assertEqual(result.ai_foreground_voxels, 1)
        self.assertEqual(result.edit_fraction_of_ai_foreground, 1.0)

    def test_strips_leading_singleton_channel(self):
        reviewer = np.ones((1, 3, 3), dtype=np.int16)
        ai = np.zeros((1, 3, 3), dtype=np.int16)
        result = diff_arrays(reviewer, ai)
        self.assertEqual(result.edit_voxel_count, 9)

    def test_3d_volumes_work_correctly(self):
        reviewer = np.ones((3, 3, 3), dtype=np.int16)
        ai = np.zeros((3, 3, 3), dtype=np.int16)
        result = diff_arrays(reviewer, ai)
        self.assertEqual(result.edit_voxel_count, 27)

    def test_shape_mismatch_raises_value_error(self):
        reviewer = np.ones((3, 3), dtype=np.int16)
        ai = np.ones((4, 4), dtype=np.int16)
        with self.assertRaises(ValueError):
            diff_arrays(reviewer, ai)


class AnnotationDiffFilesTest(unittest.TestCase):
    """File-based tests for diff_files."""

    def setUp(self):
        self.tmp = Path(__file__).parent / "__tmp_diff_test"
        self.tmp.mkdir(exist_ok=True)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_diff_files_returns_correct_diff(self):
        reviewer = np.array([[1, 1, 0], [0, 0, 0], [0, 0, 0]], dtype=np.int16)
        ai = np.array([[1, 0, 0], [0, 0, 0], [0, 0, 0]], dtype=np.int16)
        r_path = self.tmp / "reviewer.nii.gz"
        a_path = self.tmp / "ai.nii.gz"
        r_path.write_bytes(_make_nifti_bytes(reviewer))
        a_path.write_bytes(_make_nifti_bytes(ai))
        result = diff_files(str(r_path), str(a_path))
        self.assertEqual(result.edit_voxel_count, 1)

    def test_diff_files_shape_mismatch_raises(self):
        reviewer = np.ones((3, 3), dtype=np.int16)
        ai = np.ones((4, 4), dtype=np.int16)
        r_path = self.tmp / "reviewer.nii.gz"
        a_path = self.tmp / "ai.nii.gz"
        r_path.write_bytes(_make_nifti_bytes(reviewer))
        a_path.write_bytes(_make_nifti_bytes(ai))
        with self.assertRaises(ValueError):
            diff_files(str(r_path), str(a_path))

    def test_diff_files_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            diff_files("/nonexistent/reviewer.nii.gz", "/nonexistent/ai.nii.gz")


if __name__ == "__main__":
    unittest.main()
