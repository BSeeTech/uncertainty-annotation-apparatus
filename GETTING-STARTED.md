# Getting Started Guide

## 🎉 Your Platform is Running!

You now have a fully functional medical imaging annotation platform with:
- ✅ **PostgreSQL** — Database for annotations and events
- ✅ **Orthanc** — PACS for DICOM storage
- ✅ **MONAI Label** — AI-assisted segmentation
- ✅ **Uncertainty Service** — Worklist, inference, event logging
- ✅ **OHIF Viewer** — Web-based DICOM viewer with uncertainty mode

---

## 👩‍⚕️ For radiologists and non-technical testers

You do **not** need to understand any of the commands in this document. Ask the
person who installed the platform to run **one script** that prepares everything
for you, then you only use the browser:

```
powershell -ExecutionPolicy Bypass -File scripts/setup-demo-data.ps1
```

That script downloads the example data (about 1.5 GB — this is the only step
that takes time, up to 30+ minutes on a slow connection, and it resumes if
interrupted), converts it, and prepares the AI model. When it finishes it prints
a green "Demo data is ready!" message.

Then, in your browser:

| What you want to do | Where to go |
|---------------------|-------------|
| **See the review worklist** | http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2 |
| **Browse images like in a PACS** | http://localhost:3000 |
| **Look at the PACS storage** | http://localhost:8042/app/explorer.html |

**If something doesn't load:** the most common cause is that Docker Desktop is
not running. Look for the Docker icon (a whale 🐳) in your system tray
(bottom-right of the screen); if it's not there or not showing "Engine running",
start it, wait for it to become ready, then refresh the browser page.

If you were given this platform **without the example data already prepared**
(the script above was never run), the AI review screens will show an empty
worklist. That is expected — run the script (or ask the installer to run it)
and the five example cases will appear.

---

## Quick Start Commands

### Check All Services
```powershell
# View all running containers
docker ps

# Check individual services
docker logs medical-postgres --tail 20
docker logs medical-orthanc --tail 20
docker logs medical-monai --tail 20
docker logs medical-uncertainty --tail 20
```

### Access Points
| Service | URL | Purpose |
|---------|-----|---------|
| **OHIF Viewer** | http://localhost:3000 | Main annotation interface |
| **Orthanc Admin** | http://localhost:8042/app/explorer.html | PACS management |
| **Uncertainty API** | http://localhost:58050/docs | API docs (OpenAPI/Swagger) |
| **MONAI Label** | http://localhost:8000/docs | Inference API docs |
| **PostgreSQL** | `localhost:5432` | Database (user: `medical_imaging`) |

---

## Entering a Review Session

The platform uses URL parameters to switch between workflow conditions:

### Basic Usage
```
http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2
```

### Available Conditions
| Condition | URL | What You See |
|-----------|-----|-------------|
| **C0 — Manual** | `?reviewer=R01&condition=C0` | Blank viewport — draw from scratch |
| **C1 — AI-only** | `?reviewer=R01&condition=C1` | AI mask loaded, no heatmap |
| **C2 — Full uncertainty** | `?reviewer=R01&condition=C2` | AI mask + entropy heatmap + prioritised worklist |
| **C3 — Placebo** ⚠️ | `?reviewer=R01&condition=C3` | *Scaffolding only — cannot run a session yet* |
| **C4 — Worklist only** ⚠️ | `?reviewer=R01&condition=C4` | *Scaffolding only — cannot run a session yet* |
| **C5 — Heatmap only** ⚠️ | `?reviewer=R01&condition=C5` | *Scaffolding only — cannot run a session yet* |

> **C0–C2 are implemented and verified.** C3–C5 (placebo saliency, worklist-only,
> heatmap-only) are gated scaffolding toward a six-arm factorial extension: the
> `Condition` type, client plan computation, and MONAI Label `saliency_placebo` task
> exist, but the server rejects inference for C3–C5 with HTTP 400 and no test
> exercises them. Use C0–C2 for sessions.

---

## Step-by-Step: Your First Annotation

### 1. Open a Case
1. Navigate to `http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2`
2. The **Uncertainty Worklist** panel shows scored cases
3. Click a worklist entry to open it
4. The AI mask loads automatically; the entropy heatmap appears as a coloured overlay

### 2. Use the Annotation Tools
- **Edit** — Use OHIF's standard segmentation tools (brush, scissors, threshold)
- **Inspect** — The heatmap colours indicate predictive uncertainty:
  - 🟢 Low entropy (model is confident)
  - 🟡 Medium entropy
  - 🔴 High entropy (model is uncertain — likely needs review)

### 3. Adjust the Heatmap
- Use the **Uncertainty Controls** panel to:
  - Toggle heatmap visibility (`h` keyboard shortcut)
  - Adjust opacity with the slider
- The heatmap updates in real-time as you scroll through slices

### 4. Submit Your Decision
Use the **Submission** panel to:
- **Accept** — AI mask is correct as-is (C1/C2 only — C3–C5 not runnable yet)
- **Edit** — You made changes to the AI mask
- **Reject** — AI mask is unusable; escalate for expert review

### 5. Move to the Next Case
The worklist updates automatically. Click the next case or use the `→` key.

---

## Uploading DICOM Data

```powershell
# Via Orthanc web UI: http://localhost:8042/app/explorer.html
# Click "Upload" and select DICOM files

# Or via script
.\scripts\upload-dicom.ps1 -Path ".\my-dicom-folder"
```

Once uploaded, sync cases to the uncertainty service:
```bash
curl -X POST http://localhost:58050/cases/sync
```

---

## Checking Calibration

Calibration analysis (ECE, reliability diagrams, temperature scaling) runs as a
CLI against prediction files, not as an HTTP endpoint:

```bash
cd servers/uncertainty-service

# Compute a calibration report from predictions.npz
python -m app.analysis.cli \
  --inputs /path/to/predictions.npz \
  --output /tmp/calibration-report.json \
  --n-bins 15

# Also fit temperature scaling and emit plots
python -m app.analysis.cli \
  --inputs /path/to/predictions.npz \
  --output /tmp/calibration-report.json \
  --temperature \
  --plots-dir /tmp/calibration-plots
```

See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md#analysis-scripts) for details.

---

## Collecting Session Data

All reviewer actions are logged as events:

```bash
# Count events per condition
docker exec medical-postgres psql -U medical_imaging -d annotations \
  -c "SELECT condition, event_type, COUNT(*) FROM events GROUP BY condition, event_type ORDER BY condition;"

# Export per-reviewer data
docker exec medical-postgres psql -U medical_imaging -d annotations \
  -c "SELECT * FROM events WHERE reviewer_id = 'R01' ORDER BY server_ts;" \
  -o reviewer-R01-events.csv
```

---

## Next Steps

| Guide | What You'll Learn |
|-------|-------------------|
| [User Guide](USER_GUIDE.md) | Full annotation workflow, tools, best practices |
| [Developer Guide](DEVELOPER_GUIDE.md) | Extending the platform, adding conditions, adapter pattern |
| [API Reference](API.md) | Complete REST API documentation |
| [Troubleshooting](TROUBLESHOOTING.md) | Common issues and solutions |
