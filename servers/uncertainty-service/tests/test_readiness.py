import os
import sys
import unittest
from pathlib import Path

# app.main validates POSTGRES_PASSWORD at import time; the unit-test sandbox
# has no .env, so provide a dummy value (the tests never touch the database).
os.environ.setdefault("POSTGRES_PASSWORD", "test-password")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import msd_experiment_ready  # noqa: E402


def msd_row(patient_id: str, valid: bool) -> dict:
    return {
        "case_id": f"1.2.826.0.1.3680043.8.274.1.1.{patient_id}.1",
        "patient_id": patient_id,
        "msd_case": f"spleen_{patient_id}",
        "c2_generation_valid": valid,
        "error": None,
    }


def det_row(valid: bool = False) -> dict:
    return {
        "case_id": "1.2.826.0.1.3680043.8.274.1.1.8247060327.75519.4237086139.796",
        "patient_id": "DET0000101_avg",
        "msd_case": None,
        "c2_generation_valid": valid,
        "error": None,
    }


class ReadinessGateTest(unittest.TestCase):
    def _filter_msd(self, status):
        """Mirror the endpoint: readiness only considers rows with msd_case."""
        return [row for row in status if row["msd_case"]]

    def test_ready_when_all_five_msd_cases_valid_plus_extra_cases(self):
        """Falsification check: extra (non-MSD) cases must NOT block readiness."""
        status = [msd_row(f"00{i}", True) for i in range(1, 6)]
        status.append(det_row(valid=False))  # DET row has no generation
        self.assertTrue(
            msd_experiment_ready(None, self._filter_msd(status))
        )

    def test_not_ready_when_any_msd_case_missing_generation(self):
        status = [msd_row(f"00{i}", True) for i in range(1, 5)]
        status.append(msd_row("005", False))  # one MSD case invalid
        self.assertFalse(
            msd_experiment_ready(None, self._filter_msd(status))
        )

    def test_not_ready_when_fewer_than_five_msd_cases(self):
        status = [msd_row(f"00{i}", True) for i in range(1, 4)]
        self.assertFalse(
            msd_experiment_ready(None, self._filter_msd(status))
        )

    def test_not_ready_on_configuration_error(self):
        status = [msd_row(f"00{i}", True) for i in range(1, 6)]
        self.assertFalse(
            msd_experiment_ready(
                "cases.json is unreadable",
                self._filter_msd(status),
            )
        )

    def test_not_ready_when_no_msd_rows_at_all(self):
        self.assertFalse(
            msd_experiment_ready(None, self._filter_msd([det_row()]))
        )


if __name__ == "__main__":
    unittest.main()
