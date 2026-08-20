import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import main


def dicom_record(**tags):
    return {
        tag: {"vr": "UI" if tag.startswith("0020") else "LO", "Value": [value]}
        for tag, value in tags.items()
    }


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class FakeClient:
    def __init__(self, responses=None, error=None):
        self.responses = responses or {}
        self.error = error
        self.urls = []

    async def get(self, url):
        self.urls.append(url)
        if self.error is not None:
            raise self.error
        return FakeResponse(self.responses[url])


class FakePool:
    def __init__(self, existing=(), artifact_rows=()):
        self.existing = set(existing)
        self.artifact_rows = list(artifact_rows)
        self.executions = []

    async def fetch(self, query, *args):
        if "SELECT case_id FROM cases" in query:
            return [{"case_id": value} for value in self.existing]
        if "FROM cases c" in query and "uncertainty_scores" in query:
            return self.artifact_rows
        raise AssertionError(f"Unexpected fetch: {query}")

    async def execute(self, query, *args):
        self.executions.append((query, args))
        self.existing.add(args[0])
        return "INSERT 0 1"


class OrthancSyncContractTest(unittest.TestCase):
    def test_sync_inserts_discovered_cases_and_preserves_existing_condition(self):
        base = "http://orthanc.test/dicom-web"
        studies = [
            dicom_record(**{"0020000D": "study.1", "00100020": "patient001"}),
            dicom_record(**{"0020000D": "study.2", "00100020": "patient002"}),
        ]
        client = FakeClient(
            {
                f"{base}/studies": studies,
                f"{base}/studies/study.1/series": [
                    dicom_record(**{"0020000E": "series.1", "00080060": "CT"})
                ],
                f"{base}/studies/study.2/series": [
                    dicom_record(**{"0020000E": "series.2", "00080060": "CT"})
                ],
            }
        )
        pool = FakePool(existing={"study.1"})

        summary = asyncio.run(
            main.sync_cases_from_orthanc(
                pool,
                client,
                orthanc_url=base,
                default_condition="C2",
            )
        )

        self.assertEqual(
            summary,
            {"discovered": 2, "inserted": 1, "updated": 1, "skipped": 0},
        )
        self.assertEqual(len(pool.executions), 2)
        self.assertIn(
            "condition = COALESCE(cases.condition, EXCLUDED.condition)",
            pool.executions[0][0],
        )

    def test_sync_is_idempotent(self):
        base = "http://orthanc.test/dicom-web"
        client = FakeClient(
            {
                f"{base}/studies": [
                    dicom_record(**{"0020000D": "study.1", "00100020": "patient001"})
                ],
                f"{base}/studies/study.1/series": [
                    dicom_record(**{"0020000E": "series.1", "00080060": "CT"})
                ],
            }
        )
        pool = FakePool()

        first = asyncio.run(
            main.sync_cases_from_orthanc(pool, client, orthanc_url=base)
        )
        second = asyncio.run(
            main.sync_cases_from_orthanc(pool, client, orthanc_url=base)
        )

        self.assertEqual(first["inserted"], 1)
        self.assertEqual(second["inserted"], 0)
        self.assertEqual(second["updated"], 1)

    def test_best_effort_sync_returns_diagnostic_on_orthanc_failure(self):
        pool = FakePool()
        client = FakeClient(error=main.httpx.ConnectError("offline"))

        summary = asyncio.run(
            main.best_effort_sync_cases(pool, client=client)
        )

        self.assertEqual(summary["discovered"], 0)
        self.assertEqual(summary["inserted"], 0)
        self.assertEqual(summary["updated"], 0)
        self.assertEqual(summary["skipped"], 0)
        self.assertIn("offline", summary["error"])

    def test_reconcile_database_clears_urls_when_c2_generation_is_missing(self):
        pool = FakePool(
            artifact_rows=[
                {
                    "case_id": "study.stale",
                    "condition": "C2",
                    "segmentation_url": "http://old/segmentation.nii.gz",
                    "uncertainty_url": "http://old/uncertainty.nii.gz",
                }
            ]
        )

        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            main.OUTPUT_DIR = Path(tmp)
            try:
                summary = asyncio.run(main.reconcile_artifact_records(pool))
                output_dir = main.OUTPUT_DIR
            finally:
                main.OUTPUT_DIR = old_output_dir

        self.assertEqual(summary, {"checked": 1, "cleared": 1})
        self.assertFalse((output_dir / "study.stale").exists())
        query, args = pool.executions[-1]
        self.assertIn("segmentation_url = NULL", query)
        self.assertEqual(args, ("study.stale",))

    def test_set_case_condition_persists_c1_without_deleting_c2_artifacts(self):
        pool = FakePool()
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            main.OUTPUT_DIR = Path(tmp)
            try:
                uncertainty = main.output_path("study.c1", "uncertainty.nii.gz")
                uncertainty.parent.mkdir(parents=True)
                uncertainty.write_bytes(b"stale")

                asyncio.run(main.set_case_condition(pool, "study.c1", "C1"))
                uncertainty_preserved = uncertainty.exists()
            finally:
                main.OUTPUT_DIR = old_output_dir

        condition_updates = [
            execution
            for execution in pool.executions
            if "UPDATE cases SET condition = $2" in execution[0]
        ]
        self.assertEqual(condition_updates[0][1], ("study.c1", "C1"))
        self.assertTrue(uncertainty_preserved)


if __name__ == "__main__":
    unittest.main()
