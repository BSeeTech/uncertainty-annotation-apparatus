# CT spleen DICOM validation

- Overall status: **PASS**
- Cases: 5
- DICOM instances: 281
- SOP Instance UIDs unique across all cases: True
- Tools: Plastimatch 1.9.4, pydicom 3.0.2, nibabel 5.4.2

| Case | Instances | Matrix | Spacing (row x col x slice mm) | Pixel match | Status |
|---|---:|---:|---:|---:|---:|
| spleen_10 | 55 | 512 x 512 | 0.976562 x 0.976562 x 5 | max abs error 0 | PASS |
| spleen_19 | 51 | 512 x 512 | 0.796875 x 0.796875 x 5 | max abs error 0 | PASS |
| spleen_29 | 103 | 512 x 512 | 0.859375 x 0.859375 x 5 | max abs error 0 | PASS |
| spleen_1 | 34 | 512 x 512 | 0.642578 x 0.642578 x 5 | max abs error 0 | PASS |
| spleen_15 | 38 | 512 x 512 | 0.740234 x 0.740234 x 5 | max abs error 0 | PASS |

Each case passed checks for DICOM preamble/readability, CT Image Storage SOP class, modality, patient identity, matrix and slice count, Study/Series/Frame UID consistency, SOP Instance UID uniqueness, geometry, signed 16-bit pixel encoding, and exact voxel values after accounting for DICOM orientation.
