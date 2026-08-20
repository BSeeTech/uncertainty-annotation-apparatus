import sys
import tempfile
import unittest
from pathlib import Path

import nibabel as nib
import numpy as np


MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from verify_orthanc_mapping import compare_nifti_sources  # noqa: E402


class MappingGeometryTest(unittest.TestCase):
    def test_accepts_equivalent_canonical_nifti_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.nii.gz"
            converted = root / "converted.nii.gz"
            values = np.arange(24, dtype=np.float32).reshape((2, 3, 4))
            affine = np.diag([0.8, 0.8, 5.0, 1.0])
            nib.save(nib.Nifti1Image(values, affine), source)
            nib.save(nib.Nifti1Image(values + 0.5, affine), converted)

            result = compare_nifti_sources(source, converted)

            self.assertEqual(result["shape"], [2, 3, 4])
            self.assertEqual(result["spacing"], [0.8, 0.8, 5.0])
            self.assertEqual(result["max_abs_hu_difference"], 0.5)

    def test_rejects_geometry_or_intensity_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.nii.gz"
            converted = root / "converted.nii.gz"
            nib.save(
                nib.Nifti1Image(
                    np.zeros((2, 2, 2), dtype=np.float32),
                    np.eye(4),
                ),
                source,
            )
            nib.save(
                nib.Nifti1Image(
                    np.full((2, 2, 2), 2.0, dtype=np.float32),
                    np.eye(4),
                ),
                converted,
            )

            with self.assertRaisesRegex(ValueError, "intensity"):
                compare_nifti_sources(source, converted)


if __name__ == "__main__":
    unittest.main()
