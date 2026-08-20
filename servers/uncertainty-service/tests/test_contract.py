import io
import gzip
import struct
import asyncio
import sys
import types
import zipfile
import tempfile
import unittest
import json
from pathlib import Path

# The runtime image includes asyncpg, but the lightweight unit-test sandbox used
# for this patch does not.  The tests only exercise pure file/URL helpers,
# so a tiny import-time stub is enough.
if "asyncpg" not in sys.modules:
    asyncpg_stub = types.SimpleNamespace(
        Pool=object,
        PostgresError=Exception,
        create_pool=None,
    )
    sys.modules["asyncpg"] = asyncpg_stub

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException

from app import main
from app.artifact_generation import publish_generation
from tests.test_result_manifest import valid_c2_manifest


def nifti_bytes(values=(0, 1, 0, 1), datatype=2):
    header = bytearray(348)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<hhhh", header, 40, 3, len(values), 1, 1)
    struct.pack_into("<h", header, 70, datatype)
    struct.pack_into("<h", header, 72, 8 if datatype == 2 else 32)
    struct.pack_into("<f", header, 108, 348.0)
    header[344:348] = b"n+1\0"
    if datatype == 2:
        body = bytes(values)
    elif datatype == 16:
        body = struct.pack(f"<{len(values)}f", *values)
    else:
        raise ValueError(datatype)
    return gzip.compress(bytes(header) + body)


def zipped_monai_response(segmentation=None, entropy=None):
    segmentation = segmentation or nifti_bytes()
    entropy = entropy if entropy is not None else nifti_bytes(
        (0.1, 0.8, 0.2, 0.7),
        datatype=16,
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("prediction.nii.gz", segmentation)
        if entropy is not None:
            zf.writestr("prediction_entropy.nii.gz", entropy)
    return buf.getvalue()


class InferenceOutputContractTest(unittest.TestCase):
    def test_infer_reuses_valid_c2_artifacts_without_calling_monai(self):
        class FakePool:
            def __init__(self):
                self.executions = []

            async def fetchrow(self, query, *args):
                return {
                    "case_id": "case.cached",
                    "patient_id": "patient",
                    "study_uid": "study",
                    "series_uid": "series",
                    "condition": "C2",
                }

            async def execute(self, query, *args):
                self.executions.append((query, args))
                return "UPDATE 1"

        class ForbiddenAsyncClient:
            def __init__(self, *args, **kwargs):
                raise AssertionError("MONAI must not be called for a valid cache hit")

        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            old_pool = getattr(main.app.state, "pool", None)
            old_client = main.httpx.AsyncClient
            try:
                main.OUTPUT_DIR = Path(tmp)
                main.app.state.pool = FakePool()
                main.httpx.AsyncClient = ForbiddenAsyncClient
                staging = main.OUTPUT_DIR / "staging"
                staging.mkdir()
                manifest = valid_c2_manifest(staging)
                manifest["case_id"] = "case.cached"
                manifest["operational_scores"]["score"] = 0.7
                (staging / "result.json").write_text(
                    json.dumps(manifest),
                    encoding="utf-8",
                )
                publish_generation(
                    main.OUTPUT_DIR / "case.cached",
                    "C2",
                    staging,
                )

                result = asyncio.run(
                    main.infer("case.cached", main.InferRequest(condition="C2"))
                )

                self.assertEqual(result["case_id"], "case.cached")
                self.assertTrue(result["segmentation_url"])
                self.assertTrue(result["uncertainty_url"])
                self.assertAlmostEqual(result["score"], 0.7)
                self.assertTrue(result["cache_hit"])
            finally:
                main.OUTPUT_DIR = old_output_dir
                main.httpx.AsyncClient = old_client
                if old_pool is None:
                    delattr(main.app.state, "pool")
                else:
                    main.app.state.pool = old_pool

    def test_persists_stable_c1_c2_output_names_with_cache_busting_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            old_public_url = main.PUBLIC_UNCERTAINTY_SERVICE_URL
            try:
                main.OUTPUT_DIR = Path(tmp)
                main.PUBLIC_UNCERTAINTY_SERVICE_URL = "http://uncertainty.test"

                segmentation_url, uncertainty_url = main.persist_monai_inference_response(
                    "case.001",
                    zipped_monai_response(),
                    require_uncertainty=True,
                )

                self.assertTrue((main.OUTPUT_DIR / "case.001" / "segmentation.nii.gz").exists())
                self.assertTrue((main.OUTPUT_DIR / "case.001" / "uncertainty.nii.gz").exists())
                self.assertIn("/files/case.001/segmentation.nii.gz?v=", segmentation_url)
                self.assertIn("/files/case.001/uncertainty.nii.gz?v=", uncertainty_url)
            finally:
                main.OUTPUT_DIR = old_output_dir
                main.PUBLIC_UNCERTAINTY_SERVICE_URL = old_public_url

    def test_c2_requires_uncertainty_nifti_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            try:
                main.OUTPUT_DIR = Path(tmp)
                with self.assertRaises(HTTPException) as ctx:
                    main.persist_monai_inference_response(
                        "case.002",
                        zipped_monai_response_without_entropy(),
                        require_uncertainty=True,
                    )
                self.assertEqual(ctx.exception.status_code, 502)
                self.assertIn("C2 requires uncertainty.nii.gz", str(ctx.exception.detail))
            finally:
                main.OUTPUT_DIR = old_output_dir

    def test_c1_removes_stale_uncertainty_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            try:
                main.OUTPUT_DIR = Path(tmp)
                case_dir = main.OUTPUT_DIR / "case.003"
                case_dir.mkdir(parents=True)
                stale = case_dir / "uncertainty.nii.gz"
                stale.write_bytes(nifti_bytes((0.4,), datatype=16))

                segmentation_url, uncertainty_url = main.persist_monai_inference_response(
                    "case.003",
                    nifti_bytes((1, 0, 1)),
                    require_uncertainty=False,
                )

                self.assertIn("segmentation.nii.gz?v=", segmentation_url)
                self.assertIsNone(uncertainty_url)
                self.assertFalse(stale.exists())
            finally:
                main.OUTPUT_DIR = old_output_dir

    def test_rejects_invalid_nifti_before_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            try:
                main.OUTPUT_DIR = Path(tmp)
                with self.assertRaises(HTTPException) as ctx:
                    main.persist_monai_inference_response(
                        "case.004",
                        b"not-a-nifti",
                        require_uncertainty=False,
                    )
                self.assertEqual(ctx.exception.status_code, 502)
                self.assertFalse(
                    main.output_path("case.004", "segmentation.nii.gz").exists()
                )
            finally:
                main.OUTPUT_DIR = old_output_dir

    def test_incomplete_c2_replacement_preserves_previous_valid_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            try:
                main.OUTPUT_DIR = Path(tmp)
                main.persist_monai_inference_response(
                    "case.005",
                    zipped_monai_response(),
                    require_uncertainty=True,
                )
                old_seg = main.output_path("case.005", "segmentation.nii.gz").read_bytes()
                old_unc = main.output_path("case.005", "uncertainty.nii.gz").read_bytes()

                with self.assertRaises(HTTPException):
                    main.persist_monai_inference_response(
                        "case.005",
                        zipped_monai_response_without_entropy(
                            segmentation=nifti_bytes((1, 1, 1, 1, 1))
                        ),
                        require_uncertainty=True,
                    )

                self.assertEqual(
                    main.output_path("case.005", "segmentation.nii.gz").read_bytes(),
                    old_seg,
                )
                self.assertEqual(
                    main.output_path("case.005", "uncertainty.nii.gz").read_bytes(),
                    old_unc,
                )
            finally:
                main.OUTPUT_DIR = old_output_dir

    def test_regeneration_changes_cache_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            try:
                main.OUTPUT_DIR = Path(tmp)
                first, _ = main.persist_monai_inference_response(
                    "case.006",
                    nifti_bytes((0, 1)),
                )
                second, _ = main.persist_monai_inference_response(
                    "case.006",
                    nifti_bytes((0, 1, 1, 0, 1)),
                )
                self.assertNotEqual(first, second)
            finally:
                main.OUTPUT_DIR = old_output_dir

    def test_c0_reconciliation_removes_both_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            try:
                main.OUTPUT_DIR = Path(tmp)
                main.persist_monai_inference_response(
                    "case.007",
                    zipped_monai_response(),
                    require_uncertainty=True,
                )

                main.reconcile_artifact_files("case.007", "C0")

                self.assertFalse(
                    main.output_path("case.007", "segmentation.nii.gz").exists()
                )
                self.assertFalse(
                    main.output_path("case.007", "uncertainty.nii.gz").exists()
                )
            finally:
                main.OUTPUT_DIR = old_output_dir

    def test_output_file_disables_browser_caching(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_output_dir = main.OUTPUT_DIR
            try:
                main.OUTPUT_DIR = Path(tmp)
                path = main.output_path("case.008", "segmentation.nii.gz")
                path.parent.mkdir(parents=True)
                path.write_bytes(nifti_bytes())

                response = asyncio.run(
                    main.output_file("case.008", "segmentation.nii.gz")
                )

                self.assertIn("no-store", response.headers["cache-control"])
                self.assertEqual(response.headers["pragma"], "no-cache")
            finally:
                main.OUTPUT_DIR = old_output_dir

    def test_compose_declares_persistent_artifact_volume(self):
        candidates = [
            Path("/docker-compose.yml"),
            Path(__file__).resolve().parent.parent.parent.parent / "docker-compose.yml",
        ]
        compose_path = next(path for path in candidates if path.exists())
        compose = compose_path.read_text(encoding="utf-8")

        self.assertIn(
            "UNCERTAINTY_OUTPUT_DIR=/var/lib/uncertainty-service/outputs",
            compose,
        )
        self.assertIn(
            "MONAI_LABEL_TIMEOUT_SECONDS=${MONAI_LABEL_TIMEOUT_SECONDS:-7200}",
            compose,
        )
        self.assertIn("MC_DROPOUT_SAMPLES=16", compose)
        self.assertIn(
            "MONAI_CHECKPOINT_PATH=/workspace/app/model/pretrained_segmentation.pt",
            compose,
        )
        self.assertIn(
            "MONAI_CHECKPOINT_LOCK=/workspace/app/model/checkpoint.lock.json",
            compose,
        )
        self.assertIn(
            "EVALUATION_CASES_PATH=/evaluation/cases.json",
            compose,
        )
        self.assertIn(
            "PUBLIC_UNCERTAINTY_SERVICE_URL=${PUBLIC_UNCERTAINTY_SERVICE_URL:-http://localhost:8043/uncertainty}",
            compose,
        )
        self.assertIn(
            "./evaluation/ct-spleen:/evaluation:ro",
            compose,
        )
        self.assertIn(
            "./servers/monai-label/model/checkpoint.lock.json:/workspace/app/model/checkpoint.lock.json:ro",
            compose,
        )
        self.assertIn(
            "uncertainty-artifacts:/var/lib/uncertainty-service/outputs",
            compose,
        )
        self.assertIn("\n  uncertainty-artifacts:\n", compose)


def zipped_monai_response_without_entropy(segmentation=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("prediction.nii.gz", segmentation or nifti_bytes())
    return buf.getvalue()


if __name__ == "__main__":
    unittest.main()
