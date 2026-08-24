# Troubleshooting Guide

Common issues and solutions for the Uncertainty Annotation Apparatus (UAA).

## Table of Contents

- [Installation Issues](#installation-issues)
- [Docker Issues](#docker-issues)
- [Uncertainty Service Issues](#uncertainty-service-issues)
- [OHIF Viewer Issues](#ohif-viewer-issues)
- [MONAI Label Issues](#monai-label-issues)
- [Database Issues](#database-issues)
- [Condition & Evaluation Issues](#condition--evaluation-issues)
- [Performance Issues](#performance-issues)

---

## Installation Issues

### PowerShell rejects `&&` while configuring OHIF

**Cause:** Windows PowerShell 5.1 does not support `&&` as a command separator.

**Fix:** From the `ohif-viewer` directory, run each command separately:

```powershell
Set-Location platform/app
Copy-Item .env.example .env
Set-Location ../..
yarn dev
```

If OHIF was already running, stop it with `Ctrl+C` and restart `yarn dev` after
creating the file. The message `Failed to load ./.env` should then disappear.

### PowerShell says `source` is not recognized

**Cause:** `source venv/bin/activate` is a Bash command. If it fails, subsequent
`pip install` commands affect Conda or your user Python instead of the new
virtual environment.

**Fix:** From `servers/uncertainty-service`, activate the Windows environment
and confirm its interpreter before installing anything:

```powershell
& .\venv\Scripts\Activate.ps1
python -c "import sys; print(sys.executable)"
python -m pip install -r requirements.txt
```

The printed path must end in
`servers\uncertainty-service\venv\Scripts\python.exe`.

### `servers/uncertainty-service/.env.example` does not exist

This is expected. The root example file is for Docker and contains
Docker-internal hostnames. For a manual host-side run, set `DATABASE_URL`,
`MONAI_LABEL_URL`, and `ORTHANC_DICOMWEB_URL` as shown in the manual section of
[INSTALL.md](INSTALL.md#uncertainty-service). For the recommended Docker setup,
do not start a second local Uvicorn process; use `docker compose up -d`.

### PostgreSQL authentication fails

The evaluation apparatus consistently uses `uaa-evaluation-only`. PostgreSQL
stores the credential when its data volume is first initialized, so changing
`.env` does not rewrite an existing database user's password. Use the password
that initialized the volume or, if its evaluation data may be discarded,
recreate the volumes using the warning-labeled uninstallation command below.

### `docker compose` command not found

**Cause:** Docker Compose v1 (`docker-compose`) is deprecated.

**Fix:** Use Docker Compose v2 (built into Docker Desktop):
```bash
# Instead of:
docker-compose up -d

# Use:
docker compose up -d
```

### Port already in use

**Fix:** Change the host port mapping in `docker-compose.yml`:
```yaml
ports:
  - "58051:58050"  # Change left side (host port)
```

---

## Docker Issues

### Container exits immediately

**Cause:** Missing environment variables or health check failure.

**Fix:**
```bash
# Check logs
docker logs medical-uncertainty --tail 50

# Verify .env contains POSTGRES_PASSWORD
grep POSTGRES_PASSWORD .env
```

### `medical-monai` fails to start

**Cause:** MONAI Label needs a pretrained checkpoint.

**Fix:**
```bash
# The checkpoint should be at:
ls servers/monai-label/model/pretrained_segmentation.pt

# If missing, provision it (downloads the official spleen UNet and verifies SHA-256):
python servers/monai-label/scripts/install_checkpoint.py
```

### Docker volume permission errors

**Fix (Windows):**
```powershell
# Share drives in Docker Desktop settings
# Docker Desktop → Settings → Resources → File Sharing
# Add the folder where you cloned this repository
```

---

## Uncertainty Service Issues

### `GET /health` returns 503

**Cause:** Database not yet initialised (race condition on first startup).

**Fix:**
```bash
# Wait for PostgreSQL to be healthy
docker compose logs -f medical-postgres
# Then restart the uncertainty service
docker compose restart uncertainty-service
```

### Worklist returns empty

**Cause:** No cases are registered in the database.

**Fix:**
```bash
# Sync from Orthanc
curl -X POST http://localhost:8043/uncertainty/cases/sync

# Or register manually
curl -X POST http://localhost:8043/uncertainty/cases \
  -H "Content-Type: application/json" \
  -d '{"case_id": "my_case", "study_uid": "1.2.3", "series_uid": "1.2.3.1"}'
```

### Inference fails with HTTP 403

**Cause:** The inference request included `"force": true`, which is blocked for browser safety.

**Fix:** Remove `force` or set to `false`:
```json
{"condition": "C2", "force": false}
```

### `MONAI Label inference response did not contain a segmentation NIfTI`

**Cause:** The MONAI Label task returned an unexpected output format.

**Fix:**
```bash
# Check MONAI Label logs
docker compose logs monai-label --tail 50

# Verify the task name matches (C2 → mcdropout_seg, C3 → saliency_placebo)
```

### Events not being logged

**Cause:** CORS blocking sendBeacon, or event payload too large.

**Fix:**
```bash
# Verify ALLOWED_ORIGINS includes the OHIF origin
echo $ALLOWED_ORIGINS

# Check browser console for CORS errors
# Check the network tab for failed POST /events requests
```

---

## OHIF Viewer Issues

### Blank viewport when opening a case

**Cause:** Case not found in worklist or segmentation failed.

**Fix:**
1. Check the browser console (F12) for errors
2. Verify the case exists: `curl http://localhost:8043/uncertainty/cases`
3. Check the Uncertainty Controls panel for error messages

### "No reviewer session is active"

**Cause:** Missing or invalid URL parameters.

**Fix:**
```
http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2
```

The reviewer ID must be non-empty. The condition must be one of: C0, C1, C2 (C3–C5 are gated scaffolding — inference is rejected for them).

### Heatmap not visible (C2)

**Cause:** Volume actor not initialised or heatmap loading failed.

**Fix:**
1. Check the Uncertainty Controls panel for error messages
2. Try toggling the heatmap with the `h` key
3. Verify the uncertainty NIfTI was generated: `curl http://localhost:8043/uncertainty/files/{case_id}/uncertainty.nii.gz`
4. Check browser console for WebGL errors

### "Accept" button disabled

**Cause:** In C0, Accept is intentionally disabled because there is no AI mask.

**Fix:** Use C1/C2 for AI-assisted conditions, or use Edit/Reject in C0.

### Segmentation tools not working

**Cause:** Cornerstone3D tools not initialised.

**Fix:** Refresh the page and try again. If persistent, check:
```bash
docker compose logs ohif-viewer 2>/dev/null || echo "OHIF not running in Docker"
```

---

## MONAI Label Issues

### MONAI Label cannot connect to Orthanc

**Cause:** Orthanc is not ready when MONAI Label starts.

**Fix:** This is normal — MONAI Label has a 20-second sleep before connecting. Wait for the health check:
```bash
docker compose logs -f monai-label
# Look for "Successfully connected to DICOMweb"
```

### Segmentation quality is poor

**Cause:** The pretrained model may not generalise to your data.

**Note:** The platform uses a pretrained model (CT spleen segmentation). For other anatomies or modalities, you would need to train a new model.

### MC Dropout inference is slow

**Cause:** T=16 forward passes on CPU (default).

**Fix:**
```bash
# Enable GPU
Set CUDA_VISIBLE_DEVICES=0 in docker-compose.yml for monai-label service
# Or reduce samples
Set MC_DROPOUT_SAMPLES=5 in environment
```

---

## Database Issues

### Cannot connect to PostgreSQL

**Cause:** Wrong credentials or PostgreSQL not running.

**Fix:**
```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Test connection
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT 1"
```

### Missing tables

**Cause:** Database not initialised.

**Fix:**
```bash
# Manually run init script
docker exec -i medical-postgres psql -U medical_imaging -d annotations < scripts/init-db.sql
```

### Duplicate events in database

**Cause:** sendBeacon retry on page unload.

**Note:** This is a known limitation of sendBeacon. Use `DISTINCT` in queries or deduplicate by `(case_id, reviewer_id, event_type, client_ts)`.

---

## Condition & Evaluation Issues

### Wrong condition displayed

**Cause:** URL parameter mismatch or missing condition.

**Fix:**
```
# Correct URL format:
http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2

# Check current session state:
curl http://localhost:8043/uncertainty/worklist?reviewer_id=R01
```

### C3/C5 conditions — expected behaviour

**Expected:** C3 and C5 are gated scaffolding: the tasks (`saliency_placebo`,
`mcdropout_seg`) and the six-arm `Condition` type exist, but `POST /infer/{case_id}`
returns HTTP 400 for them and no test exercises them. They are not runnable
conditions yet — use C0–C2.

### "Unknown worklist policy" error

**Cause:** Invalid policy parameter sent to the API.

**Fix:** Valid policies are: `fifo`, `high_first`, `low_first`, `default`. The client
sends no policy and the server defaults to `high_first`; the other orderings are not
wired to any condition.

---

## Performance Issues

### OHIF Viewer is slow

**Causes and fixes:**
- **Large DICOM series**: Use the scrollbar to preload only visible slices
- **Heatmap rendering**: Reduce opacity to improve GPU performance
- **Low RAM**: Close other browser tabs; restart Docker Desktop
- **CPU-only MONAI**: Inferences take longer — set `MC_DROPOUT_SAMPLES=5`

### Docker containers use too much RAM

**Fix:** Limit per-container memory in `docker-compose.yml`:
```yaml
services:
  monai-label:
    deploy:
      resources:
        limits:
          memory: 4G
```

### Disk space full

**Cause:** Pre-computed inference artifacts and Docker volumes accumulate.

**Fix:**
```bash
# Clean Docker artifacts
docker system prune -af

# Remove old volumes (WARNING: deletes data)
docker compose down -v
```
