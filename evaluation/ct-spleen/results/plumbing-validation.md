# Synthetic Plumbing Validation

- Provenance: `synthetic_plumbing_validation`
- Generated: 2026-06-24T14:25:11.265243+00:00

| Test | Passed | Details |
|---|---:|---|
| C2 inference produces entropy and probability | ✅ | run_inferer returned pred_entropy and pred_probability with correct shapes |
| C2 archive contains all four expected entries | ✅ | segmentation.nii.gz, uncertainty.nii.gz, foreground_probability.nii.gz, result.json |
| Checkpoint verification passes | ✅ | sha256=b606697f... size=19297197 |
| T=16 enforced at runtime | ✅ | All 5 C2 precompute runs report num_samples=16 |
| C1 produces deterministic segmentation only | ✅ | All 5 C1 precompute runs report num_samples=1, dropout=0.0 |
| Cache-only inference < 5s | ✅ | All 5 C2 cases return in < 0.2s, all 5 C1 cases return in < 0.05s |

**All tests passed:** True
