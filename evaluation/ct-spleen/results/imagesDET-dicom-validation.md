# imagesDET DICOM validation

- Overall status: **PASS**
- Source NIfTI volumes: 83
- DICOM series: 83
- DICOM instances: 1009
- Source manifest completeness and MD5/size integrity: PASS
- SOP Instance UIDs unique across the dataset: PASS
- Pixel comparison: exact for every passing series (maximum absolute error 0)
- DICOM classification: CT Image Storage, Image Type DERIVED/SECONDARY/AXIAL
- Tools: Plastimatch 1.9.4, pydicom 3.0.2, nibabel 5.4.2

## Geometry summary

- Matrix shapes observed: 36
- In-plane dimensions: 192-512 by 156-512 pixels
- Slices per series: 8-17
- Slice spacing distribution: 6 mm (29), 7 mm (2), 8 mm (50), 10 mm (2)

## Failed series

None. All 83 series passed every validation check.

Checks covered source manifest integrity, DICOM preamble/readability, CT SOP class, derived-image classification, identity, slice count and numbering, matrix, Study/Series/Frame UID consistency, SOP UID uniqueness, orientation, pixel and slice spacing, pixel encoding, and exact reconstructed voxel values.
