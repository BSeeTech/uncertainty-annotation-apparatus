import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.runtime_jobs import SingleFlightJobs


class SingleFlightJobsTest(unittest.TestCase):
    def test_reuses_running_job_for_same_case_and_condition(self):
        calls = []
        gate = asyncio.Event()

        async def runner():
            calls.append("run")
            await gate.wait()
            return {"ok": True}

        async def exercise():
            jobs = SingleFlightJobs()
            first = jobs.start("case.001", "C2", runner)
            second = jobs.start("case.001", "C2", runner)
            self.assertEqual(first.job_id, second.job_id)
            self.assertEqual(calls, [])
            await asyncio.sleep(0)
            self.assertEqual(calls, ["run"])
            gate.set()
            await first.task
            self.assertEqual(jobs.status(first.job_id)["status"], "completed")

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
