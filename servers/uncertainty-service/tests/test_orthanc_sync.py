import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.orthanc_sync import DiscoveredCase, choose_series, discover_cases


def dicom_record(**tags):
    return {
        tag: {"vr": "UI" if tag.startswith("0020") else "LO", "Value": [value]}
        for tag, value in tags.items()
    }


class OrthancDiscoveryTest(unittest.TestCase):
    def test_discovers_case_from_study_and_series_metadata(self):
        study_uid = "1.2.3.study"
        series_uid = "1.2.3.series"
        studies = [
            dicom_record(
                **{
                    "0020000D": study_uid,
                    "00100020": "patient001",
                }
            )
        ]
        series_by_study = {
            study_uid: [
                dicom_record(
                    **{
                        "0020000E": series_uid,
                        "00080060": "CT",
                    }
                )
            ]
        }

        cases, skipped = discover_cases(
            studies,
            series_by_study,
            default_condition="C2",
        )

        self.assertEqual(
            cases,
            [
                DiscoveredCase(
                    case_id=study_uid,
                    patient_id="patient001",
                    study_uid=study_uid,
                    series_uid=series_uid,
                    condition="C2",
                )
            ],
        )
        self.assertEqual(skipped, [])

    def test_prefers_image_modality_over_seg_and_is_deterministic(self):
        selected = choose_series(
            [
                dicom_record(**{"0020000E": "9.seg", "00080060": "SEG"}),
                dicom_record(**{"0020000E": "2.ct", "00080060": "CT"}),
                dicom_record(**{"0020000E": "1.ct", "00080060": "CT"}),
            ]
        )

        self.assertEqual(selected["0020000E"]["Value"][0], "1.ct")

    def test_rejects_non_ct_image_modalities(self):
        selected = choose_series(
            [
                dicom_record(**{"0020000E": "1.mr", "00080060": "MR"}),
                dicom_record(**{"0020000E": "2.pt", "00080060": "PT"}),
            ]
        )

        self.assertIsNone(selected)

    def test_reports_studies_without_usable_series_as_skipped(self):
        study_uid = "1.2.3.empty"
        studies = [dicom_record(**{"0020000D": study_uid})]

        cases, skipped = discover_cases(
            studies,
            {study_uid: [dicom_record(**{"0020000E": "1.seg", "00080060": "SEG"})]},
            default_condition="C1",
        )

        self.assertEqual(cases, [])
        self.assertEqual(skipped, [study_uid])


if __name__ == "__main__":
    unittest.main()
