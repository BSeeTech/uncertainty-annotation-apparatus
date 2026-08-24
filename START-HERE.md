# Start here

Use this page to choose the shortest path through the Uncertainty Annotation
Apparatus (UAA). UAA is a research prototype for studying uncertainty-guided
medical-image annotation. It is not a clinical product and must not be used for
patient diagnosis or treatment.

## I am reviewing prepared cases

You need only a supported web browser and a session link from the study
operator. A typical link looks like:

```text
http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2
```

Do not change the `reviewer` or `condition` values unless the study operator
asks you to. Open the link, select a case in **Uncertainty Worklist**, review the
segmentation, then use **Accept**, **Submit edited annotation**, or **Reject**.

Useful keys in the review mode are:

| Key | Action |
|---|---|
| `u` | Show or hide the uncertainty heatmap in C2 |
| `a` | Accept the current AI annotation |
| `r` | Reject the current case |
| `Shift+u` | Refresh the worklist |

The heatmap shows model uncertainty, not known error. A bright region deserves
attention but is not proof that the segmentation is wrong. See the
[User Guide](USER_GUIDE.md) for the complete workflow.

## I am preparing a local demonstration

Ask a technical installer to complete the [Installation Guide](INSTALL.md).
After the services and viewer are running, the installer can prepare the five
public spleen examples from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-demo-data.ps1
```

This downloads about 1.5 GB, installs Python conversion packages, requires
`plastimatch`, converts NIfTI volumes to DICOM, uploads them to Orthanc,
registers the cases, and performs MC Dropout inference. On CPU, expect the
inference stage alone to take roughly 20 minutes. The script is safe to rerun.

When it reports **Demo data is ready**, open the C2 session link shown above.
If the worklist is empty, use the checks in [Troubleshooting](TROUBLESHOOTING.md).

## I am installing or developing UAA

Follow these documents in order:

1. [Installation Guide](INSTALL.md) - prerequisites, configuration, startup,
   and verification.
2. [Getting Started](GETTING-STARTED.md) - first session and operator tasks.
3. [Developer Guide](DEVELOPER_GUIDE.md) - architecture and tests.
4. [API Reference](API.md) - REST and WebSocket contracts.
5. [Evaluation replication](evaluation/ct-spleen/README.md) - research-data
   provenance and the reproducible evaluation sequence.

## What is implemented

- C0: manual annotation.
- C1: AI pre-annotation without an uncertainty heatmap.
- C2: AI pre-annotation, predictive-entropy heatmap, and prioritised worklist.
- C3-C5: design scaffolding only; they are not runnable study conditions.

The repository is newer than the thesis's recorded implementation snapshot.
Use the thesis for the research rationale and reported evaluation; use the
checked-out repository and its tests for current operational behavior.

