import gzip
import logging
import math
import struct
from array import array
from pathlib import Path
from typing import Sequence


logger = logging.getLogger(__name__)

# Inference status labels — more granular than just the numeric score.
#   "completed"         → normal, foreground voxels found, score is meaningful
#   "empty_foreground"  → mask is all background (no segmentation produced)
#   "invalid_input"     → NIfTI data looks corrupted (NaN, all-zero, etc.)
#   "error"             → I/O or parsing failure
InferenceStatus = str  # one of the above

STATUS_COMPLETED = "completed"
STATUS_EMPTY_FOREGROUND = "empty_foreground"
STATUS_INVALID_INPUT = "invalid_input"
STATUS_ERROR = "error"

ZERO_SCORE = {
    "score": 0.0,
    "score_p95": 0.0,
    "score_fraction_above": 0.0,
    "score_mean_all": 0.0,
    "band": "low",
}


# Cross-layer contract with the client's DEFAULT_BAND_THRESHOLDS
# (ohif-viewer/extensions/extension-uncertainty/src/utils/scoreBand.ts).
# Kept as named constants, not inline literals, so EC5's equality test
# (audit/tests/test_cross_layer_contracts.py) has a stable symbol to import
# rather than having to regex the function body.
MEDIUM_THRESHOLD = 0.15
HIGH_THRESHOLD = 0.35


def score_band(score: float) -> str:
    if score >= HIGH_THRESHOLD:
        return "high"
    if score >= MEDIUM_THRESHOLD:
        return "medium"
    return "low"


def compute_uncertainty_scores(
    segmentation_path: Path,
    uncertainty_path: Path,
    threshold: float = 0.5,
) -> dict[str, float | str]:
    try:
        segmentation = read_nifti_values(segmentation_path)
        uncertainty = read_nifti_values(uncertainty_path)
    except (OSError, ValueError, struct.error) as exc:
        logger.warning("Unable to read uncertainty maps: %s", exc)
        result = dict(ZERO_SCORE)
        result["inference_status"] = STATUS_ERROR
        return result

    count = min(len(segmentation), len(uncertainty))
    if count == 0:
        result = dict(ZERO_SCORE)
        result["inference_status"] = STATUS_INVALID_INPUT
        return result
    if len(segmentation) != len(uncertainty):
        logger.warning(
            "Segmentation/uncertainty voxel count mismatch: %d != %d",
            len(segmentation),
            len(uncertainty),
        )

    all_values = [float(value) for value in uncertainty[:count]]
    segmentation_values = [float(segmentation[i]) for i in range(count)]

    # Check for invalid input data (NaN, inf, or entirely flat)
    n_nan = sum(1 for v in all_values if math.isnan(v) or math.isinf(v))
    seg_nan = sum(1 for v in segmentation_values if math.isnan(v) or math.isinf(v))
    seg_sum = sum(segmentation_values)
    if n_nan > 0 or seg_nan > 0:
        logger.warning(
            "Invalid data in NIfTI maps: uncertainty NaN/inf=%d, seg NaN/inf=%d",
            n_nan,
            seg_nan,
        )
        result = dict(ZERO_SCORE)
        result["score_mean_all"] = mean(all_values)
        result["inference_status"] = STATUS_INVALID_INPUT
        return result

    foreground = [
        uncertainty[i]
        for i in range(count)
        if segmentation_values[i] > 0
    ]

    if not foreground:
        # Check if segmentation is all-zero (empty mask)
        if seg_sum <= 0.5:
            logger.info(
                "Segmentation mask is empty (all background) for %s",
                segmentation_path,
            )
            result = dict(ZERO_SCORE)
            result["score_mean_all"] = mean(all_values)
            result["inference_status"] = STATUS_EMPTY_FOREGROUND
            return result
        # Foreground is empty despite non-zero segmentation values (unlikely but handle it)
        result = dict(ZERO_SCORE)
        result["score_mean_all"] = mean(all_values)
        result["inference_status"] = STATUS_EMPTY_FOREGROUND
        return result

    score = mean(foreground)
    return {
        "score": score,
        "score_p95": percentile(foreground, 95),
        "score_fraction_above": (
            sum(1 for value in foreground if value > threshold) / len(foreground)
        ),
        "score_mean_all": mean(all_values),
        "band": score_band(score),
        "inference_status": STATUS_COMPLETED,
    }


def read_nifti_values(path: Path) -> list[float]:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)

    endian = "<"
    sizeof_hdr = struct.unpack_from("<i", raw, 0)[0]
    if sizeof_hdr != 348:
        sizeof_hdr = struct.unpack_from(">i", raw, 0)[0]
        endian = ">"
    if sizeof_hdr != 348:
        raise ValueError(f"{path} is not a NIfTI-1 file")

    dims = struct.unpack_from(f"{endian}8h", raw, 40)
    dim_count = max(0, int(dims[0]))
    voxel_count = 1
    for dim in dims[1 : dim_count + 1]:
        voxel_count *= max(1, int(dim))

    datatype = struct.unpack_from(f"{endian}h", raw, 70)[0]
    vox_offset = int(struct.unpack_from(f"{endian}f", raw, 108)[0])
    typecode, bytes_per_voxel = nifti_array_type(datatype)
    body = raw[vox_offset : vox_offset + voxel_count * bytes_per_voxel]
    values = array(typecode)
    values.frombytes(body)
    if endian == ">":
        values.byteswap()
    return [float(value) for value in values[:voxel_count]]


def nifti_array_type(datatype: int) -> tuple[str, int]:
    if datatype == 2:
        return "B", 1
    if datatype == 4:
        return "h", 2
    if datatype == 16:
        return "f", 4
    if datatype == 512:
        return "H", 2
    raise ValueError(f"Unsupported NIfTI datatype: {datatype}")


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def percentile(values: Sequence[float], percent: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = (len(ordered) - 1) * percent / 100.0
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[int(rank)]
    weight = rank - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight
