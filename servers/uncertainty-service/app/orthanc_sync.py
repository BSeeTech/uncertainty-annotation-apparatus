import logging
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


logger = logging.getLogger(__name__)


IMAGE_MODALITIES = frozenset({"CT"})


@dataclass(frozen=True)
class DiscoveredCase:
    case_id: str
    patient_id: str | None
    study_uid: str
    series_uid: str
    condition: str


def dicom_value(record: dict[str, Any], tag: str) -> Any | None:
    element = record.get(tag)
    if not isinstance(element, dict):
        return None
    values = element.get("Value")
    if not isinstance(values, list) or not values:
        return None
    return values[0]


def choose_series(
    series_records: Sequence[dict[str, Any]],
) -> dict[str, Any] | None:
    candidates = [
        record
        for record in series_records
        if str(dicom_value(record, "00080060") or "").upper() in IMAGE_MODALITIES
        and dicom_value(record, "0020000E")
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda record: str(dicom_value(record, "0020000E")))


def discover_cases(
    study_records: Sequence[dict[str, Any]],
    series_by_study: Mapping[str, Sequence[dict[str, Any]]],
    default_condition: str,
) -> tuple[list[DiscoveredCase], list[str]]:
    cases: list[DiscoveredCase] = []
    skipped: list[str] = []

    for study in study_records:
        study_uid = dicom_value(study, "0020000D")
        if not study_uid:
            continue
        study_uid = str(study_uid)
        series = choose_series(series_by_study.get(study_uid, ()))
        if series is None:
            skipped.append(study_uid)
            available_modalities = sorted(
                {
                    str(series_rec.get("00080060", {}).get("Value", ["?"])[0])
                    for series_rec in series_by_study.get(study_uid, ())
                }
            )
            logger.debug(
                "Skipped study %s — no CT series found (available modalities: %s)",
                study_uid,
                available_modalities or "no series data",
            )
            continue

        cases.append(
            DiscoveredCase(
                case_id=study_uid,
                patient_id=(
                    str(dicom_value(study, "00100020"))
                    if dicom_value(study, "00100020") is not None
                    else None
                ),
                study_uid=study_uid,
                series_uid=str(dicom_value(series, "0020000E")),
                condition=default_condition,
            )
        )

    return cases, skipped
