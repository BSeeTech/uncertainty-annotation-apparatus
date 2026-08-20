"""Single-flight state for administrative long-running generation jobs."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable


@dataclass
class JobHandle:
    job_id: str
    case_id: str
    condition: str
    task: asyncio.Task


class SingleFlightJobs:
    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], JobHandle] = {}
        self._status: dict[str, dict[str, Any]] = {}

    def start(
        self,
        case_id: str,
        condition: str,
        runner: Callable[[], Awaitable[Any]],
    ) -> JobHandle:
        key = (case_id, condition)
        existing = self._by_key.get(key)
        if existing is not None and not existing.task.done():
            return existing

        job_id = str(uuid.uuid4())
        self._status[job_id] = {
            "job_id": job_id,
            "case_id": case_id,
            "condition": condition,
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
        }

        async def execute() -> Any:
            try:
                result = await runner()
                self._status[job_id].update(
                    {
                        "status": "completed",
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "result": result,
                    }
                )
                return result
            except Exception as exc:
                self._status[job_id].update(
                    {
                        "status": "failed",
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "error": str(exc),
                    }
                )
                raise
            finally:
                self._by_key.pop(key, None)

        handle = JobHandle(
            job_id=job_id,
            case_id=case_id,
            condition=condition,
            task=asyncio.create_task(execute()),
        )
        self._by_key[key] = handle
        return handle

    def status(self, job_id: str) -> dict[str, Any]:
        if job_id not in self._status:
            raise KeyError(job_id)
        return dict(self._status[job_id])
