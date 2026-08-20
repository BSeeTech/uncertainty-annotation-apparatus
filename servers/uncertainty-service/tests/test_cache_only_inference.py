import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException

from app import main
from app.artifact_generation import publish_generation
from tests.test_result_manifest import valid_c2_manifest


class FakePool:
    def __init__(self):
        self.executions = []

    async def fetchrow(self, query, *args):
        return {
            "case_id": "case.001",
            "patient_id": "patient001",
            "study_uid": "study.001",
            "series_uid": "series.001",
            "condition": "C2",
        }

    async def execute(self, query, *args):
        self.executions.append((query, args))
        return "UPDATE 1"


class ForbiddenAsyncClient:
    def __init__(self, *args, **kwargs):
        raise AssertionError("browser inference must never call MONAI")


class CacheOnlyInferenceTest(unittest.TestCase):
    def setUp(self):
        self.old_output_dir = main.OUTPUT_DIR
        self.old_pool = getattr(main.app.state, "pool", None)
        self.old_client = main.httpx.AsyncClient
        self.temp = tempfile.TemporaryDirectory()
        main.OUTPUT_DIR = Path(self.temp.name)
        main.app.state.pool = FakePool()
        main.httpx.AsyncClient = ForbiddenAsyncClient

    def tearDown(self):
        main.OUTPUT_DIR = self.old_output_dir
        main.httpx.AsyncClient = self.old_client
        if self.old_pool is None:
            delattr(main.app.state, "pool")
        else:
            main.app.state.pool = self.old_pool
        self.temp.cleanup()

    def publish_c2(self):
        staging = main.OUTPUT_DIR / "staging"
        staging.mkdir()
        manifest = valid_c2_manifest(staging)
        (staging / "result.json").write_text(
            json.dumps(manifest),
            encoding="utf-8",
        )
        publish_generation(main.OUTPUT_DIR / "case.001", "C2", staging)

    def test_returns_valid_generation_without_contacting_monai(self):
        self.publish_c2()

        result = asyncio.run(
            main.infer("case.001", main.InferRequest(condition="C2"))
        )

        self.assertTrue(result["cache_hit"])
        self.assertEqual(result["num_samples"], 16)
        self.assertEqual(
            result["checkpoint_sha256"],
            (
                "b606697f9efad300bbb3b1115abd1245"
                "b29e5de0c9de8fac052ab6d2d94f920a"
            ),
        )
        self.assertEqual(result["score"], 0.683)

    def test_missing_generation_returns_structured_409(self):
        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                main.infer("case.001", main.InferRequest(condition="C2"))
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(
            context.exception.detail["code"],
            "generation_required",
        )

    def test_force_is_rejected_on_public_route(self):
        self.publish_c2()

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                main.infer(
                    "case.001",
                    main.InferRequest(condition="C2", force=True),
                )
            )

        self.assertEqual(context.exception.status_code, 403)

    def test_condition_changes_do_not_delete_c1_or_c2_generations(self):
        self.publish_c2()
        c2_current = main.current_generation_path("case.001", "C2")

        asyncio.run(main.set_case_condition(main.app.state.pool, "case.001", "C0"))
        asyncio.run(main.set_case_condition(main.app.state.pool, "case.001", "C1"))
        asyncio.run(main.set_case_condition(main.app.state.pool, "case.001", "C2"))

        self.assertEqual(
            main.current_generation_path("case.001", "C2"),
            c2_current,
        )


if __name__ == "__main__":
    unittest.main()
