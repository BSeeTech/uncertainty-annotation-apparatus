# monai_label_app — MC Dropout Segmentation Server

MONAI Label app for the Medical Imaging Platform. Registers two inference tasks against the same official MONAI spleen UNet backbone:

| Task name         | Behaviour                                     | Used for                               |
|-------------------|-----------------------------------------------|----------------------------------------|
| `segmentation`    | Single deterministic forward pass             | Evaluation condition **C1** (AI only)  |
| `mcdropout_seg`   | T stochastic forward passes + entropy volume  | Evaluation condition **C2** (AI + uncertainty) |

Both tasks share the same checkpoint, so a single training run gives you the model for both conditions. That's what makes the C1 vs C2 contrast a clean ablation: only the inference loop differs.

---

## Layout

```
monai_label_app/
├── main.py                           # MONAI Label entrypoint (UncertaintyApp)
├── Dockerfile
├── requirements.txt
├── lib/
│   ├── infers/
│   │   ├── network.py                # official spleen UNet + strict loading
│   │   ├── segmentation.py           # plain BasicInferTask
│   │   └── mcdropout_seg.py          # MCDropoutSegmentation (the meat)
│   └── configs/
│       ├── segmentation.py           # TaskConfig for the baseline
│       └── mcdropout_seg.py          # TaskConfig for MC Dropout
├── scripts/
│   ├── smoke_test.py                 # in-process smoke test (Python)
│   ├── smoke_test.sh                 # HTTP smoke test against a running server
│   ├── seed_synthetic.py             # drops a synthetic NIfTI into studies dir
│   └── check_math.py                 # pure-numpy correctness check (no torch)
├── model/                            # checkpoints land here
└── data/                             # studies dir (DICOM/NIfTI series)
```

---

## What `MCDropoutSegmentation` does

1. Calls `network.eval()`, then re-enables only `nn.Dropout*` layers (BatchNorm stays in eval mode using running stats).
2. Performs T stochastic sliding-window forward passes; accumulates softmax sum and softmax-squared sum in float32 across passes.
3. Computes:
   - **mean predictive distribution** `p̄ = (1/T) Σ softmax(logits_t)`
   - **predictive entropy** `H(p̄) = -Σ_k p̄_k · log p̄_k`, in nats, with range `[0, ln K]`.
   - **per-class variance** (kept as a side channel for ablations).
4. Wraps each output as a `MetaTensor` carrying the input image's spatial metadata so MONAI Label's `Restored` transform maps the entropy volume back to the original image geometry alongside the segmentation.
5. Overrides `writer()` to emit two NIfTI files:
   - `<base>.nii.gz` — segmentation (uint8)
   - `<base>_entropy.nii.gz` — predictive entropy (float32)

Reading the implementation start-to-finish takes about ten minutes; it's deliberately compact.

---

## Quick start

### 0. Static math check (no torch, no MONAI)

Verifies the MC Dropout sampling algorithm against analytic ground truth (uniform → ln K, delta → 0, dropout=0 → standard softmax entropy):

```bash
python scripts/check_math.py
```

Expected: all four checks pass. This is the cheapest way to confirm the algorithm is right before you spend disk on torch.

### 1. Build the image

```bash
docker build -t uagent/monai-label .
```

### 2. Run it

```bash
docker run --rm -p 58000:8000 \
    -v "$PWD/data:/workspace/data" \
    -v "$PWD/model:/workspace/app/model" \
    uagent/monai-label
```

Or use the project-level `docker-compose.yml` from the standalone scaffold.

### 3. Drop a synthetic test image and run the integration smoke test

```bash
python scripts/seed_synthetic.py --out-dir ./data/dicom
./scripts/smoke_test.sh
```

Expected output ends with:

```
PHASE-1 SMOKE TEST PASSED
  segmentation : ./smoke_out/unpacked/synthetic_case_001.nii.gz
  entropy      : ./smoke_out/unpacked/synthetic_case_001_entropy.nii.gz
```

### 4. Run the in-process smoke test (no server, faster)

```bash
python scripts/smoke_test.py --samples 4
```

This bypasses the HTTP layer and drives `MCDropoutSegmentation` directly. Useful when iterating on the inference logic itself.

---

## Configuration

Pass these via `--conf` when starting the server (or via `environment:` in docker-compose):

| Key                  | Default        | Meaning                                           |
|----------------------|----------------|---------------------------------------------------|
| `models`             | `all`          | Comma-separated subset of `segmentation,mcdropout_seg` |
| `labels`             | `spleen`       | Comma-separated foreground class names            |
| `dropout`            | `0.2`          | Dropout rate in the MONAI UNet                    |
| `mc_dropout_samples` | `16`           | T (number of stochastic passes for MC Dropout)    |
| `target_spacing`     | `1.5,1.5,2.0`  | Resampling target spacing in mm                   |
| `intensity_range`    | `-175,250`     | `(a_min, a_max)` for `ScaleIntensityRanged`       |

Example (multi-class abdominal segmentation, faster MC inference):

```bash
monailabel start_server \
    --app /workspace/app \
    --studies /workspace/data/dicom \
    --conf labels "spleen,liver,kidney_right,kidney_left" \
    --conf mc_dropout_samples 16 \
    --conf intensity_range "-200,300"
```

---

## Bringing your own weights

This Phase-1 package ships **architecture only, no weights**. A working training pipeline lives in a later phase; for now the recommended paths are:

1. **MONAI Bundle import.** Train using one of the public MONAI bundles (e.g. `spleen_ct_segmentation`) and copy the weights to `model/pretrained_segmentation.pt`.  Both `segmentation` and `mcdropout_seg` will pick them up automatically.
2. **Train externally.** Any training script that produces a `state_dict` matching the UNet config in `lib/infers/network.py` will work. Save as `model/segmentation.pt`.
3. **No weights at all.** The smoke tests still pass — they verify the inference plumbing, not the model quality. Random weights produce noisy entropy, which is fine for plumbing checks.

---

## What Phase 1 does *not* include (yet)

- Calibration (temperature scaling, ECE) — Phase 7.
- Case-level uncertainty scoring — Phase 2 (lives in the FastAPI service).
- Worklist or event logging — Phase 3.
- Storage of uncertainty as DICOM Parametric Maps — out of scope for Phase 1; NIfTI sidecar is sufficient until the FastAPI service decides where to persist.
- A trainer class — `init_trainers()` returns `{}`. Add later if you want training inside the app.

These are deliberate scope boundaries for Phase 1, not omissions.

---

## Troubleshooting

**`MCDropoutSegmentation: the network contains no Dropout layers; MC sampling will return T identical predictions.`**
The network you wired in has no `nn.Dropout*` modules. Either set `dropout > 0` when constructing the UNet (the default in `network.py` does this), or insert dropout manually. The smoke test will fail loudly if this happens.

**`entropy uniformly zero — dropout was probably not active.`**
Same root cause — confirm with `count_dropout_layers(network)`.

**Inference is too slow on CPU.**
The checkpoint-backed experiment fixes `mc_dropout_samples` at 16. Use a
smaller value only for explicitly labeled synthetic plumbing validation; do
not mix those outputs into the experimental results.

**`libcudart.so.12: cannot open shared object file`**
You're running the GPU-style torch wheel without CUDA libs. Either install with `--extra-index-url https://download.pytorch.org/whl/cpu` (the Dockerfile already does this) or run on a machine with CUDA available.
