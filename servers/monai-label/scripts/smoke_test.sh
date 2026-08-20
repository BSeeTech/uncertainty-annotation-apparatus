#!/usr/bin/env bash
# Phase-1 end-to-end smoke test against a running MONAI Label server.
#
# What it verifies:
#   1. The server is up and /info lists both 'segmentation' and 'mcdropout_seg'.
#   2. POST /infer/mcdropout_seg returns a 200 with a multipart response.
#   3. The unzipped response contains both a segmentation NIfTI and an
#      entropy NIfTI sidecar.
#
# Prereqs:
#   * Docker compose stack up (`docker compose up -d monai-label`).
#   * At least one DICOM series in your studies dir.  If you don't have
#     one yet, run scripts/seed_synthetic.py first to drop one in.
#
# Usage:
#   ./scripts/smoke_test.sh                       # uses defaults
#   MONAI_URL=http://host:58000 ./smoke_test.sh   # remote server
#   IMAGE_ID=case_001 ./smoke_test.sh             # specific image
set -euo pipefail

MONAI_URL="${MONAI_URL:-http://localhost:58000}"
IMAGE_ID="${IMAGE_ID:-}"
OUT_DIR="${OUT_DIR:-./smoke_out}"

echo "==> 1. Ping /info"
info=$(curl -fsSL "${MONAI_URL}/info/" || { echo "    server unreachable at ${MONAI_URL}"; exit 1; })
echo "${info}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
infers = list(data.get('models', {}).keys())
print(f'    registered infers: {infers}')
required = {'segmentation', 'mcdropout_seg'}
missing = required - set(infers)
if missing:
    print(f'    MISSING: {missing}'); sys.exit(2)
print('    OK both required infers present')
"

echo "==> 2. Pick an image"
if [ -z "${IMAGE_ID}" ]; then
    IMAGE_ID=$(curl -fsSL "${MONAI_URL}/datastore/?output=all" \
        | python3 -c "import json,sys; d=json.load(sys.stdin); ids=list(d.get('objects',{}).keys()); print(ids[0] if ids else '')")
    if [ -z "${IMAGE_ID}" ]; then
        echo "    ERROR: no images in datastore. Add a DICOM series or NIfTI to your studies dir first."
        exit 3
    fi
fi
echo "    using image_id=${IMAGE_ID}"

echo "==> 3. POST /infer/mcdropout_seg"
mkdir -p "${OUT_DIR}"
response_zip="${OUT_DIR}/response.zip"
curl -fsSL -o "${response_zip}" \
     -X POST \
     "${MONAI_URL}/infer/mcdropout_seg?image=${IMAGE_ID}&output=image"
echo "    response saved to ${response_zip} ($(stat -c%s "${response_zip}") bytes)"

echo "==> 4. Unzip and inspect"
unzip -o "${response_zip}" -d "${OUT_DIR}/unpacked" > /dev/null
files=$(find "${OUT_DIR}/unpacked" -type f | sort)
echo "${files}" | sed 's/^/    /'

# Look for the seg + entropy NIfTI pair
seg=$(echo "${files}" | grep -E '\.nii\.gz$' | grep -v '_entropy' | head -1 || true)
ent=$(echo "${files}" | grep -E '_entropy\.nii\.gz$' | head -1 || true)

if [ -z "${seg}" ]; then
    echo "    ERROR: no segmentation NIfTI in response"; exit 4
fi
if [ -z "${ent}" ]; then
    echo "    ERROR: no entropy NIfTI sidecar in response"
    echo "    (Check that MCDropoutSegmentation.writer is being called and"
    echo "     that the FastAPI worker is forwarding the multipart payload.)"
    exit 5
fi

echo "    seg     : ${seg}"
echo "    entropy : ${ent}"

echo "==> 5. Verify entropy properties"
python3 - "${ent}" <<'PY'
import sys, numpy as np, nibabel as nib
ent = nib.load(sys.argv[1]).get_fdata().astype(np.float32)
print(f"    shape={ent.shape}  min={ent.min():.4f}  max={ent.max():.4f}  mean={ent.mean():.4f}")
assert ent.min() >= -1e-5,    f"negative entropy: min={ent.min()}"
# Binary segmentation -> max entropy ≈ ln(2) ≈ 0.6931
assert ent.max() <= 0.7,      f"entropy exceeds ln(2): max={ent.max()}"
assert ent.max() > 0,         "entropy uniformly zero — dropout not active?"
print("    OK entropy values are in expected range")
PY

echo
echo "============================================================"
echo "PHASE-1 SMOKE TEST PASSED"
echo "  segmentation : ${seg}"
echo "  entropy      : ${ent}"
echo "============================================================"
