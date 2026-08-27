# Thesis capability validation protocol

This document is the acceptance-test companion to [INSTALL.md](INSTALL.md). Use it after completing the installation and MSD restoration. It validates the capabilities implemented for the thesis, records evidence suitable for technical review, and distinguishes working functionality from research-prototype limitations.

This is not a clinical-validation protocol. The MSD images are public research data, reviewer identifiers are synthetic, and the repository's reviewer-level outcomes are simulated. Conditions **C0, C1, and C2 are runnable**. C3, C4, and C5 are design scaffolding and must not be reported as operational study conditions.

## Test record

Create an evidence directory before testing:

```powershell
Set-Location C:\uncertainty-annotation-apparatus
$Evidence = Join-Path (Get-Location) ("validation-evidence\" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
docker compose ps | Out-File "$Evidence\docker-compose-ps.txt"
git rev-parse HEAD | Out-File "$Evidence\git-commit.txt"
```

For every test, record `PASS`, `FAIL`, or `NOT IMPLEMENTED`, the tester, date, case/reviewer ID, and evidence filename. A capability passes only when every mandatory expected result is observed.

| ID | Capability | Result | Evidence/notes |
|---|---|---|---|
| A1 | Automated regression suites | NOT RUN | |
| A2 | Infrastructure and restored data | NOT RUN | |
| A3 | Model identity and provenance | NOT RUN | |
| A4 | C0/C1/C2 isolation | NOT RUN | |
| A5 | Segmentation and uncertainty outputs | NOT RUN | |
| A6 | Heatmap rendering and controls | NOT RUN | |
| A7 | Worklist prioritisation | NOT RUN | |
| A8 | Accept/edit/reject workflow | NOT RUN | |
| A9 | Event and timing telemetry | NOT RUN | |
| A10 | PostgreSQL persistence and restart | NOT RUN | |
| A11 | Collaboration service | NOT RUN | |
| A12 | Study allocation and NASA-TLX fixtures | NOT RUN | |
| A13 | Technical metrics and report | NOT RUN | |
| A14 | Failure recovery and resumability | NOT RUN | |

## A1. Automated regression suites

### Uncertainty service

```powershell
Set-Location C:\uncertainty-annotation-apparatus
.\.venv\Scripts\Activate.ps1
python -c "import sys; assert sys.version_info[:2] == (3, 12), 'Recreate .venv with: py -3.12 -m venv .venv'"
python -m pip install -r servers/uncertainty-service/requirements-test.txt
python -m pip install -r evaluation/ct-spleen/requirements.txt
python -m pytest -q servers/uncertainty-service/tests evaluation/ct-spleen/tests
```

The install command is intentionally repeated here so an existing checkout
that was updated with `git pull` receives newly added test dependencies.

**Pass:** all tests pass. The maintained Python baseline is 135 tests; a
higher count is acceptable.

If dependency installation mentions `cp314` or `Python314`, the existing
virtual environment was created with Python 3.14. Return to INSTALL.md section
2 and recreate `.venv` with the explicitly selected Python 3.12 interpreter.

### OHIF uncertainty extension and review mode

These commands assume `yarn install` from [INSTALL.md](INSTALL.md) completed:

```powershell
Set-Location C:\uncertainty-annotation-apparatus\ohif-viewer
yarn workspace @thesis/extension-uncertainty test --runInBand
yarn workspace @thesis/mode-uncertainty-review test --runInBand
yarn workspace @thesis/extension-uncertainty typecheck
yarn workspace @thesis/mode-uncertainty-review typecheck
```

**Pass:** both Jest suites and both type checks exit with code 0. The maintained
baselines are 119 extension tests and 93 mode tests; higher counts are
acceptable. Save terminal output in the evidence directory.

Use this suite-by-suite inventory rather than combining historical counts from
the thesis PDF with current output:

| Suite | Maintained baseline |
|---|---:|
| Python service and evaluation | 135 |
| OHIF uncertainty extension | 119 |
| OHIF uncertainty-review mode | 93 |
| **Current total** | **347** |

The total is a repository regression-test count, not a count of participants,
cases, independent experiments, or thesis claims.

## A2. Infrastructure and restored data

```powershell
Set-Location C:\uncertainty-annotation-apparatus
docker compose ps

Invoke-RestMethod http://localhost:8043/uncertainty/health
Invoke-RestMethod http://localhost:8043/uncertainty/health/ready
$Cases = Invoke-RestMethod http://localhost:8043/uncertainty/cases
$Studies = Invoke-RestMethod http://localhost:8042/studies
$Cases | Format-Table case_id, patient_id, condition, inference_status, score, band
"Registered cases: $($Cases.Count)"
"Orthanc studies: $($Studies.Count)"
```

Also verify the restored source files:

```powershell
$Required = @(
  "evaluation/ct-spleen/data/imagesTr/spleen_10.nii.gz",
  "evaluation/ct-spleen/data/imagesTr/spleen_19.nii.gz",
  "evaluation/ct-spleen/data/imagesTr/spleen_29.nii.gz",
  "evaluation/ct-spleen/data/imagesTs/spleen_1.nii.gz",
  "evaluation/ct-spleen/data/imagesTs/spleen_15.nii.gz",
  "evaluation/ct-spleen/data/labelsTr/spleen_10.nii.gz",
  "evaluation/ct-spleen/data/labelsTr/spleen_19.nii.gz",
  "evaluation/ct-spleen/data/labelsTr/spleen_29.nii.gz"
)
$Required | ForEach-Object { [pscustomobject]@{ File = $_; Exists = Test-Path $_ } }
```

**Pass:** core containers are running/healthy, readiness reports ready, five MSD cases and at least five Orthanc studies exist, and every required file reports `True`.

## A3. Model identity, dataset integrity, and provenance

```powershell
python servers/monai-label/scripts/install_checkpoint.py
python evaluation/ct-spleen/install_dataset.py
Get-Content servers/monai-label/model/checkpoint.lock.json
Get-Content evaluation/ct-spleen/dataset.lock.json
```

Inspect a precomputed result:

```powershell
$Cases = Invoke-RestMethod http://localhost:8043/uncertainty/cases
$CaseId = ($Cases | Where-Object inference_status -eq "completed" | Select-Object -First 1).case_id
$Case = $Cases | Where-Object case_id -eq $CaseId | Select-Object -First 1
$Result = Invoke-RestMethod "http://localhost:8043/uncertainty/results/$CaseId`?condition=C2"
$Case | ConvertTo-Json -Depth 8
$Result | ConvertTo-Json -Depth 8
```

**Pass:** both installers complete without integrity errors. The C2 result contains model/checkpoint identity, checkpoint SHA-256, `num_samples` of 16, artifact generation/provenance under `artifacts.segmentation` and `artifacts.uncertainty`, metrics version, and inference status. The corresponding case record supplies the public `segmentation_url` and `uncertainty_url` used by the viewer. Both URLs return non-empty files. Do not expect the result endpoint to duplicate those public URLs at its top level.

The installation loader precomputes C2. Before comparing all three conditions, also create the deterministic C1 artifacts:

```powershell
docker exec medical-uncertainty python /app/scripts/precompute_cases.py `
  --cases /evaluation/cases.json `
  --condition C1 `
  --report /tmp/precompute-c1.json
```

**Pass:** the command completes for the five MSD cases. DET-only rows in the manifest may be reported as skipped because their imaging data is not part of this CT spleen restoration.

## A4. C0/C1/C2 experimental isolation

Use a different synthetic reviewer for each condition to keep evidence independent:

- C0: <http://localhost:3000/uncertainty-review?reviewer=R10&condition=C0>
- C1: <http://localhost:3000/uncertainty-review?reviewer=R11&condition=C1>
- C2: <http://localhost:3000/uncertainty-review?reviewer=R12&condition=C2>

Open the same case from each worklist and verify:

| Capability | C0 | C1 | C2 |
|---|---:|---:|---:|
| CT images | visible | visible | visible |
| AI segmentation imported | no | yes | yes |
| Accept AI mask | disabled | enabled | enabled |
| Manual/edited submission | enabled | enabled after AI mask loads | enabled after AI mask loads |
| Heatmap controls | disabled | disabled | enabled |
| Uncertainty score/band | hidden | hidden | visible |
| Worklist policy selector | hidden | hidden | visible |

Test the hotkeys with the viewer focused: `u` toggles the C2 heatmap, `a` accepts an AI mask where allowed, `r` opens rejection, and `Shift+u` refreshes the worklist. Do not use `a` or `r` until ready to create a submission record.

**Pass:** every cell matches. Any uncertainty information visible in C0 or C1 is a failure because it compromises condition blinding.

## A5. Segmentation and uncertainty outputs

```powershell
$Cases = Invoke-RestMethod http://localhost:8043/uncertainty/cases
$CaseId = ($Cases | Where-Object inference_status -eq "completed" | Select-Object -First 1).case_id
$C1 = Invoke-RestMethod "http://localhost:8043/uncertainty/results/$CaseId`?condition=C1"
$C2 = Invoke-RestMethod "http://localhost:8043/uncertainty/results/$CaseId`?condition=C2"
$CaseRecord = $Cases | Where-Object case_id -eq $CaseId | Select-Object -First 1
$C1 | ConvertTo-Json -Depth 6
$C2 | ConvertTo-Json -Depth 6
$CaseRecord | ConvertTo-Json -Depth 6
```

**Pass:** C1 has `artifacts.segmentation` and no uncertainty artifact. C2 has both artifact entries, reports `num_samples: 16`, and has numeric score fields. The case record exposes the public segmentation and uncertainty URLs used by the viewer. Opening the case in C1/C2 displays an editable AI mask aligned to the CT.

## A6. C2 heatmap rendering and controls

Open C2, select a completed case, and wait for both the AI mask and heatmap to load.

1. Select **Heatmap: OFF/ON** and press `u`; the same overlay must toggle without changing the CT.
2. Move the continuous opacity control, or select its 0%, 50%, and 100% presets; the overlay must disappear, blend, and become strongest respectively.
3. Scroll slices, pan, zoom, and change window/level; the overlay must stay spatially aligned.
4. Confirm the panel shows mean foreground entropy, 95th percentile, fraction above threshold, checkpoint version, and `T=16`.
5. Select **Capture**, confirm the preview contains the same CT slice and visible overlays as the active viewport, then download both JPG and PNG images.
6. Repeat Capture in C1 and confirm the CT plus AI segmentation is present but no uncertainty heatmap is exposed.
7. Capture C2 screenshots at 0%, 50%, and 100% opacity.

**Pass:** the sequential magma heatmap is visible only in C2, controls respond, alignment is retained, the score/provenance readout is populated, and every downloaded image matches its source viewport. An endless loader, blank preview/download, missing CT or condition-appropriate overlay, stale overlay from a previous case, or CT/overlay misregistration fails the test. Refreshing the full `/uncertainty-review?...` URL must load OHIF rather than return API status 404.

## A7. Worklist ordering and case assignment

Verify API ordering directly:

```powershell
$High = Invoke-RestMethod "http://localhost:8043/uncertainty/worklist?condition=C2&policy=high_first&reviewer_id=R12"
$Low = Invoke-RestMethod "http://localhost:8043/uncertainty/worklist?condition=C2&policy=low_first&reviewer_id=R12"
$C0 = Invoke-RestMethod "http://localhost:8043/uncertainty/worklist?condition=C0&policy=fifo&reviewer_id=R10"
$C1 = Invoke-RestMethod "http://localhost:8043/uncertainty/worklist?condition=C1&policy=fifo&reviewer_id=R11"
$High | Select-Object case_id, score, score_band, status | Format-Table
$Low  | Select-Object case_id, score, score_band, status | Format-Table

$HighScores = @($High | Where-Object score -ne $null | ForEach-Object { [double]$_.score })
$LowScores = @($Low | Where-Object score -ne $null | ForEach-Object { [double]$_.score })
$HighDescending = -not (Compare-Object $HighScores ($HighScores | Sort-Object -Descending))
$LowAscending = -not (Compare-Object $LowScores ($LowScores | Sort-Object))
"High-first descending: $HighDescending"
"Low-first ascending: $LowAscending"
$C0 | Select-Object case_id, status | Format-Table
$C1 | Select-Object case_id, status | Format-Table
```

In C2, change among highest-first, lowest-first, arrival, and randomised policies. In C0/C1, confirm the selector and score badges are absent. Click a case and confirm the URL gains `caseId=...` and the row becomes selected.

**Pass:** both Boolean checks are `True`; C0/C1 retain FIFO order and contain no exposed score fields in the UI; C2 exposes policy/score controls; selection opens the matching study.

## A8. Accept, edit, reject, save, and retrieve

Use three different cases or reviewers so each outcome remains inspectable.

### Accept

In C1 or C2, wait until the AI mask reports imported and editable. Click **Accept AI mask**.

### Edit

Open another case, use an OHIF segmentation tool to add or erase a visible region, and click **Submit edited annotation**. In C0, first draw a manual annotation; accepting an AI mask must remain disabled.

### Reject

Open another case, click **Reject case**, optionally enter a reason, then **Confirm reject**. Rejection must succeed without a mask upload.

Query the recorded outcomes:

```powershell
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT case_id, reviewer_id, condition, status, mask_filename, mask_size_bytes, edit_voxel_count, created_at FROM uncertainty_annotations ORDER BY created_at DESC LIMIT 12;"
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT case_id, reviewer_id, condition, status, started_at, ended_at FROM annotation_status ORDER BY updated_at DESC LIMIT 12;"
```

Retrieve the newest accepted or edited C2 result. This command discovers the
case and reviewer automatically; do not type placeholder identifiers:

```powershell
$RecordedPair = docker exec medical-postgres psql -U medical_imaging -d annotations -At -F '|' -c "SELECT case_id, reviewer_id FROM uncertainty_annotations WHERE condition='C2' AND status IN ('accepted','edited') AND mask_filename IS NOT NULL ORDER BY created_at DESC LIMIT 1;"
if (-not $RecordedPair) { throw 'No accepted or edited C2 annotation exists. Complete the Accept or Edit procedure above, then rerun this block.' }
$CaseId, $ReviewerId = $RecordedPair.Trim() -split '\|', 2
$AnnotationUri = "http://localhost:8043/uncertainty/annotations/$([uri]::EscapeDataString($CaseId))/$([uri]::EscapeDataString($ReviewerId))?condition=C2"
$Annotation = Invoke-RestMethod $AnnotationUri -ErrorAction Stop
if (-not $Annotation.storage_url) { throw "The stored annotation has no downloadable mask: $CaseId / $ReviewerId" }
$Annotation | ConvertTo-Json -Depth 5
$RetrievedMask = "$Evidence\retrieved-reviewer-mask.nii.gz"
Invoke-WebRequest $Annotation.storage_url -OutFile $RetrievedMask -ErrorAction Stop
if ((Get-Item $RetrievedMask).Length -eq 0) { throw 'The retrieved annotation mask is empty.' }
Get-FileHash $RetrievedMask -Algorithm SHA256 -ErrorAction Stop
```

**Pass:** accepted/edited submissions have a NIfTI filename and non-zero `mask_size_bytes`; rejection has no required mask; status and timestamps persist independently per condition; GET returns the latest submission for the requested condition; `storage_url` downloads a valid, non-empty NIfTI mask. An edited C1/C2 mask reports measured AI/reviewer foreground and edit-voxel values rather than placeholder zeros.

`accepted` names the terminal action selected by the reviewer; it does not mean
that the AI mask was necessarily unchanged. Interpret it with
`edit_voxel_count` and the preceding edit telemetry: `accepted` with zero edits
is accepted unchanged, while `accepted` with non-zero edits is edited and then
accepted. The distinct `edited` status is produced by the explicit **Submit
edited annotation** action. Report these operational definitions rather than
silently relabelling stored records.

## A9. Event and timing telemetry

Using any reviewer in C2:

1. Open a case and change several slices.
2. Toggle the heatmap twice and move opacity.
3. Start and finish an edit.
4. Submit or reject, then use OHIF's back control or open another case. This records `case_close` before leaving the mode.
5. Wait a few seconds so the buffered logger flushes. A full browser unload also flushes already-buffered events, but the in-app back control is the deterministic case-close check.

```powershell
$TelemetryReviewer = docker exec medical-postgres psql -U medical_imaging -d annotations -At -c "SELECT reviewer_id FROM review_events WHERE condition='C2' ORDER BY server_ts DESC LIMIT 1;"
if (-not $TelemetryReviewer) { throw 'No C2 telemetry exists. Complete the five browser actions above, wait a few seconds, then rerun this block.' }
$TelemetryReviewer = $TelemetryReviewer.Trim()
$TelemetryReviewerSql = $TelemetryReviewer.Replace("'", "''")
"Inspecting C2 telemetry for reviewer: $TelemetryReviewer"
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT event_type, COUNT(*) FROM review_events WHERE reviewer_id='$TelemetryReviewerSql' AND condition='C2' GROUP BY event_type ORDER BY event_type;"
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT case_id, event_type, client_ts, server_ts, payload FROM review_events WHERE reviewer_id='$TelemetryReviewerSql' AND condition='C2' ORDER BY server_ts DESC LIMIT 30;"
```

**Pass:** records include the applicable `case_open`, navigation/viewport, `heatmap_toggle`, `opacity_change`, edit, submission/decision, and case-close events; every row has the correct reviewer, condition, case, and server timestamp. `client_ts` should be populated for browser-generated events. Missing heatmap events in C2 or heatmap events attributed to C0/C1 fail condition integrity.

## A10. PostgreSQL persistence and restart recovery

Record current counts, restart services, then compare:

```powershell
$RecordedPair = docker exec medical-postgres psql -U medical_imaging -d annotations -At -F '|' -c "SELECT case_id, reviewer_id FROM uncertainty_annotations WHERE condition='C2' AND status IN ('accepted','edited') AND mask_filename IS NOT NULL ORDER BY created_at DESC LIMIT 1;"
if (-not $RecordedPair) { throw 'No accepted or edited C2 annotation exists. Complete A8, then rerun A10.' }
$CaseId, $ReviewerId = $RecordedPair.Trim() -split '\|', 2
$AnnotationUri = "http://localhost:8043/uncertainty/annotations/$([uri]::EscapeDataString($CaseId))/$([uri]::EscapeDataString($ReviewerId))?condition=C2"
$StoredBefore = Invoke-RestMethod $AnnotationUri -ErrorAction Stop
if (-not $StoredBefore.storage_url) { throw "The stored annotation has no downloadable mask: $CaseId / $ReviewerId" }
$MaskBeforePath = "$Evidence\mask-before-restart.nii.gz"
$MaskAfterPath = "$Evidence\mask-after-restart.nii.gz"
Invoke-WebRequest $StoredBefore.storage_url -OutFile $MaskBeforePath -ErrorAction Stop
if ((Get-Item $MaskBeforePath).Length -eq 0) { throw 'The pre-restart annotation mask is empty.' }
$MaskHashBefore = (Get-FileHash $MaskBeforePath -Algorithm SHA256 -ErrorAction Stop).Hash
$Before = docker exec medical-postgres psql -U medical_imaging -d annotations -At -c "SELECT (SELECT COUNT(*) FROM review_events) || ',' || (SELECT COUNT(*) FROM uncertainty_annotations) || ',' || (SELECT COUNT(*) FROM annotation_status);"
docker compose restart postgres uncertainty-service collaboration-server
Start-Sleep -Seconds 20
$After = docker exec medical-postgres psql -U medical_imaging -d annotations -At -c "SELECT (SELECT COUNT(*) FROM review_events) || ',' || (SELECT COUNT(*) FROM uncertainty_annotations) || ',' || (SELECT COUNT(*) FROM annotation_status);"
$StoredAfter = Invoke-RestMethod $AnnotationUri -ErrorAction Stop
if (-not $StoredAfter.storage_url) { throw 'The annotation storage URL was lost during restart.' }
Invoke-WebRequest $StoredAfter.storage_url -OutFile $MaskAfterPath -ErrorAction Stop
if ((Get-Item $MaskAfterPath).Length -eq 0) { throw 'The post-restart annotation mask is empty.' }
$MaskHashAfter = (Get-FileHash $MaskAfterPath -Algorithm SHA256 -ErrorAction Stop).Hash
"Before: $Before"
"After:  $After"
"Mask retained: $($MaskHashBefore -eq $MaskHashAfter)"
if ($Before -ne $After) { throw "Database counts changed across restart: before=$Before after=$After" }
if ($MaskHashBefore -ne $MaskHashAfter) { throw 'The annotation mask hash changed across restart.' }
Invoke-RestMethod http://localhost:8043/uncertainty/health/ready
```

**Pass:** before/after counts match, readiness recovers, both mask downloads succeed, and `Mask retained` is `True`.

## A11. Collaboration service

The collaboration server is a separate session/Socket.IO subsystem; it is not the mechanism used by the C0–C2 single-reviewer panels. Validate its supported REST lifecycle independently:

```powershell
$Cases = Invoke-RestMethod http://localhost:8043/uncertainty/cases
$StudyUid = $Cases[0].study_uid
$Session = Invoke-RestMethod http://localhost:3001/api/sessions -Method Post -ContentType "application/json" -Body (@{ studyInstanceUID=$StudyUid; userId="validation-user" } | ConvertTo-Json)
$Session | ConvertTo-Json
Invoke-RestMethod "http://localhost:3001/api/sessions/$($Session.sessionId)"
Invoke-RestMethod http://localhost:3001/api/sessions
Invoke-RestMethod "http://localhost:3001/api/sessions/$($Session.sessionId)/close" -Method Post
```

**Pass:** create returns a session ID, detail/list can retrieve it, and close returns `closed`. Real-time multi-client synchronization requires two Socket.IO clients and is outside the C0–C2 reviewer workflow; do not imply that simultaneous reviewer edits were evaluated in the thesis unless separately demonstrated.

## A12. Counterbalancing, allocation, and NASA-TLX fixtures

Generate both deterministic research artifacts without importing them into the operational database:

```powershell
Set-Location C:\uncertainty-annotation-apparatus
.\.venv\Scripts\Activate.ps1
python scripts/generate-research-data.py --seed 42 | Tee-Object "$Evidence\research-data-generation.txt"
python scripts/generate-reviewer-data.py --seed 42 --tag validation | Tee-Object "$Evidence\reviewer-data-generation.txt"
```

Inspect:

- `evaluation/ct-spleen/research-data.sql`
- `evaluation/ct-spleen/generated-reviewer-data-validation.sql`
- `evaluation/ct-spleen/nasa-tlx-validation.csv`

**Pass:** generation reports 12 synthetic reviewers/participants, 36 sessions, 108 attempts/annotations, nine distinct cases per reviewer, counterbalanced C0/C1/C2 order, and 36 NASA-TLX rows. Repeating with seed 42 must reproduce the same research values apart from generation timestamps.

These are simulated fixtures for pipeline validation. They are not participant observations, ethics records, or evidence of usability benefit.

## A13. Technical segmentation evaluation

```powershell
Set-Location C:\uncertainty-annotation-apparatus
.\.venv\Scripts\Activate.ps1
$ErrorActionPreference = 'Stop'

# Required even in a newly recreated virtual environment. This installs the
# evaluator's declared NumPy, SciPy, nibabel, pydicom, and requests versions.
python -m pip install -r evaluation/ct-spleen/requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Evaluation dependency installation failed ($LASTEXITCODE)" }

python -c "import nibabel, numpy, scipy; print('Evaluation dependencies: OK')"
if ($LASTEXITCODE -ne 0) { throw "Evaluation dependency check failed ($LASTEXITCODE)" }

python evaluation/ct-spleen/run_evaluation.py `
  --cases evaluation/ct-spleen/cases.json `
  --references evaluation/ct-spleen/data `
  --service http://localhost:8043/uncertainty `
  --output evaluation/ct-spleen/results/experimental-results.json
if ($LASTEXITCODE -ne 0) { throw "CT-spleen evaluation failed ($LASTEXITCODE)" }

python evaluation/ct-spleen/render_report.py `
  --input evaluation/ct-spleen/results/experimental-results.json `
  --output evaluation/ct-spleen/results/experimental-report.md
if ($LASTEXITCODE -ne 0) { throw "Evaluation report generation failed ($LASTEXITCODE)" }

if (-not $Evidence) {
  $Evidence = Join-Path (Get-Location) ("validation-evidence\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
}

Copy-Item evaluation/ct-spleen/results/experimental-results.json $Evidence
Copy-Item evaluation/ct-spleen/results/experimental-report.md $Evidence
```

**Pass:** all five mapped cases are reported; the three training cases with public labels receive Dice results; the two public test cases are explicitly marked as lacking reference masks rather than silently scored. Expected Dice is approximately 0.89, 0.88, and 0.91 for the labeled cases. Small stochastic differences are acceptable but large deviations require investigation.

This validates technical segmentation behavior. It does not reproduce real reviewer performance because no human-participant study was conducted.

## A14. Failure recovery and resumability

### Idempotent data restoration

Rerun:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-demo-data.ps1
```

**Pass:** verified downloads are reused/resumed, existing cases can be registered again without duplication errors, and precomputed artifacts are reused where valid.

### Readiness failure

```powershell
Set-Location C:\uncertainty-annotation-apparatus
$ErrorActionPreference = 'Stop'

try {
  docker compose stop monai-label
  if ($LASTEXITCODE -ne 0) { throw "Could not stop MONAI Label ($LASTEXITCODE)" }

  # HTTP 503 is the expected readiness response while MONAI Label is down.
  # -SkipHttpErrorCheck prevents that expected response from aborting the test.
  $downResponse = Invoke-WebRequest `
    http://localhost:8043/uncertainty/health/ready `
    -UseBasicParsing `
    -SkipHttpErrorCheck
  $downBody = $downResponse.Content | ConvertFrom-Json
  if ($downResponse.StatusCode -lt 400 -or $downBody.ready -ne $false) {
    throw "Readiness did not report dependency loss while MONAI Label was stopped"
  }
  Write-Host "Expected degraded readiness confirmed (HTTP $($downResponse.StatusCode))."
}
finally {
  # Always restore the dependency, including when an assertion above fails.
  docker compose start monai-label
  if ($LASTEXITCODE -ne 0) { throw "Could not restart MONAI Label ($LASTEXITCODE)" }
  docker compose restart uncertainty-service
  if ($LASTEXITCODE -ne 0) { throw "Could not restart uncertainty service ($LASTEXITCODE)" }
}

$ready = $false
for ($attempt = 1; $attempt -le 60; $attempt++) {
  try {
    $health = Invoke-RestMethod `
      http://localhost:8043/uncertainty/health/ready `
      -TimeoutSec 5
    if ($health.ready -eq $true) {
      $ready = $true
      break
    }
  }
  catch {
    # Startup can temporarily return connection errors or HTTP 503.
  }
  Start-Sleep -Seconds 5
}

if (-not $ready) {
  docker compose ps
  docker compose logs --tail 100 monai-label uncertainty-service
  throw "Services did not recover within five minutes"
}
Write-Host "Readiness recovery confirmed."
```

The test must confirm HTTP 503 with `ready: false` while MONAI is stopped and
must then print `Readiness recovery confirmed.`. The `finally` block restores
the services even if the degraded-state assertion fails.

### Missing cached generation

Do not delete working artifacts merely to provoke this error. The automated server suite verifies that browser inference refuses uncached generation with a controlled `409 generation_required` response and that public callers cannot force administrative generation.

**Pass:** the installer can be rerun, readiness reflects dependency loss, and services recover without loss of PostgreSQL records.

## Final acceptance and reporting rules

The apparatus is accepted for thesis technical review when A1–A10 and A13–A14 pass. A11 validates the separately implemented collaboration subsystem. A12 validates only synthetic study plumbing.

The final review report must state all of the following:

- C0–C2 were tested; C3–C5 were not operational.
- MSD technical validation used five studies, with public reference masks for three.
- reviewer-level and NASA-TLX data are synthetic.
- this is a research/evaluation apparatus, not a medical device or clinical system.
- submitted masks were downloaded again from their recorded storage URLs and retained across the restart test.
- any failed or untested capability remains visible in the result table; it must not be silently omitted.
