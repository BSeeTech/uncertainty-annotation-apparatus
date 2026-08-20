# MONAI Label Demonstration Guide
## Uncertainty Annotation Apparatus (UAA)

---

## Table of Contents
1. [Required Datasets](#1-required-datasets)
2. [Sample Applications Overview](#2-sample-applications-overview)
3. [Models for Demonstration](#3-models-for-demonstration)
4. [Demo Scenarios for Your Platform](#4-demo-scenarios-for-your-platform)
5. [Step-by-Step Demo Setup](#5-step-by-step-demo-setup)
6. [Presentation Flow](#6-presentation-flow)
7. [Troubleshooting Tips](#7-troubleshooting-tips)

---

## 1. Required Datasets

### Primary Recommended Dataset: **Task09_Spleen**
This is the ideal starting dataset for your OHIF + Orthanc + MONAI Label stack:

| Property | Value |
|----------|-------|
| Size | ~1.5 GB |
| Format | NIfTI (.nii.gz) |
| Modality | CT (Contrast Enhanced) |
| Organs | Spleen |
| Images | 41 training + 20 test volumes |
| Labels | Ground truth included |

**Download Command:**
```bash
# Inside MONAI Label container or local environment
monailabel datasets --download --name Task09_Spleen --output /data/datasets
```

### Additional Datasets (Medical Segmentation Decathlon)

| Dataset | Task | Best For Demo |
|---------|------|---------------|
| **Task06_Lung** | Lung nodule detection | Detection showcase |
| **Task02_Heart** | Left atrium segmentation | Cardiac imaging |
| **Task03_Liver** | Liver + tumor segmentation | Multi-label demo |
| **Task07_Pancreas** | Pancreas + tumor | Complex segmentation |
| **Task10_Colon** | Colon tumor | Cancer detection |

**Download any dataset:**
```bash
monailabel datasets --download --name <DATASET_NAME> --output /data/datasets
```

### Converting NIfTI to DICOM for Orthanc

Since your platform uses Orthanc PACS with DICOMweb, you need to convert NIfTI files to DICOM:

```bash
# Install plastimatch (NIfTI to DICOM converter)
sudo apt-get install plastimatch -y

# Convert a sample volume
plastimatch convert \
    --patient-id patient001 \
    --input Task09_Spleen/imagesTr/spleen_10.nii.gz \
    --output-dicom dicom_output/patient001

# Upload to Orthanc via REST API
curl -X POST http://localhost:8042/instances \
    --data-binary @dicom_output/patient001/CT001.dcm
```

Or use Orthanc's web interface: `http://localhost:8042` → Upload → Select DICOM files

---

## 2. Sample Applications Overview

### Radiology App (Recommended for Your Platform)
Perfect for OHIF + Orthanc integration with CT/MRI images.

**Features:**
- DeepEdit (Interactive AI-assisted segmentation)
- DeepGrow (Click-based interactive segmentation)
- Automated Segmentation (UNet, UNETR models)
- Spleen-specific segmentation
- Multi-stage vertebra segmentation

**Download:**
```bash
monailabel apps --download --name radiology --output /app
```

### MONAIBundle App
Access to pre-trained models from MONAI Model Zoo:

**Available Models:**
| Model | Purpose | Organs/Structures |
|-------|---------|-------------------|
| `spleen_ct_segmentation` | Single organ | Spleen |
| `swin_unetr_btcv_segmentation` | Multi-organ | 13 abdominal organs |
| `wholeBody_ct_segmentation` | Full body | 104 structures |
| `wholeBrainSeg_Large_UNEST_segmentation` | Brain | Multiple brain regions |
| `lung_nodule_ct_detection` | Detection | Lung nodules |
| `pancreas_ct_dints_segmentation` | Multi-label | Pancreas + tumor |
| `renalStructures_UNEST_segmentation` | Kidney | Cortex, medulla, collecting system |

**Download:**
```bash
monailabel apps --download --name monaibundle --output /app
```

---

## 3. Models for Demonstration

### Tier 1: Quick Demo (5-10 minutes) - Recommended
**Spleen Segmentation with DeepEdit**

```bash
# Start server with DeepEdit model
monailabel start_server \
    --app radiology \
    --studies http://orthanc:8042/dicom-web \
    --conf models deepedit
```

**Demo Points:**
- Click a few foreground/background points
- Watch AI refine segmentation in real-time
- Show iterative improvement with more clicks
- Submit label and trigger training

### Tier 2: Impressive Demo (10-15 minutes)
**Multi-Organ Segmentation with Swin UNETR**

```bash
monailabel start_server \
    --app monaibundle \
    --studies http://orthanc:8042/dicom-web \
    --conf models swin_unetr_btcv_segmentation
```

**Demo Points:**
- One-click automated segmentation
- 13 abdominal organs segmented simultaneously
- Show 3D visualization of results
- Demonstrate editing capabilities

### Tier 3: Showstopper Demo (15-20 minutes)
**Whole Body CT Segmentation (104 structures)**

```bash
monailabel start_server \
    --app monaibundle \
    --studies http://orthanc:8042/dicom-web \
    --conf models wholeBody_ct_segmentation
```

**Demo Points:**
- Comprehensive anatomical coverage
- Clinical relevance
- Processing time comparison (manual vs AI)
- Quality metrics

---

## 4. Demo Scenarios for Your Platform

### Scenario A: "Research Lab Workflow"
**Narrative:** A research lab needs to annotate 50 CT scans for a spleen volume study.

1. Open OHIF Viewer → Select study from Orthanc
2. Launch MONAI Label panel
3. Click "Next Sample" (Active Learning selects most informative image)
4. Run DeepEdit inference
5. Refine with 2-3 clicks
6. Submit label → Triggers background training
7. Show improved model on next sample

### Scenario B: "Teaching Hospital Education"
**Narrative:** Medical students learning anatomy with AI assistance.

1. Load CT scan in OHIF
2. Run whole body or multi-organ segmentation
3. Toggle individual organ visibility
4. Use 3D MPR views to explore anatomy
5. Student adds corrections → Model learns

### Scenario C: "Clinical Decision Support"
**Narrative:** Radiologist needs quick organ volumetry.

1. Import patient scan to Orthanc
2. Auto-segment target organ
3. Calculate volume/measurements
4. Export segmentation as DICOM SEG
5. Save to PACS for clinical review

---

## 5. Step-by-Step Demo Setup

### Pre-Demo Checklist

```bash
# 1. Verify all services are running
docker-compose ps

# Expected output:
# medical-orthanc    Up   0.0.0.0:8042->8042/tcp
# medical-monailabel Up   0.0.0.0:8000->8000/tcp
# medical-postgres   Up   0.0.0.0:5432->5432/tcp
```

### Dataset Preparation Script

```bash
#!/bin/bash
# prepare_demo_data.sh

# Download dataset
monailabel datasets --download --name Task09_Spleen --output /data

# Convert first 5 samples to DICOM for Orthanc
cd /data/Task09_Spleen/imagesTr

for i in {1..5}; do
    FILE="spleen_$((9+i)).nii.gz"
    if [ -f "$FILE" ]; then
        plastimatch convert \
            --patient-id "DEMO_PATIENT_$i" \
            --input "$FILE" \
            --output-dicom "/data/dicom_output/patient_$i"
        
        # Upload to Orthanc
        for dcm in /data/dicom_output/patient_$i/*.dcm; do
            curl -X POST http://localhost:8042/instances --data-binary @"$dcm"
        done
    fi
done

echo "Demo data ready! Check http://localhost:8042 for studies."
```

### Docker-Compose Configuration for MONAI Label

Add/update your `docker-compose.yml`:

```yaml
monai-label:
  image: projectmonai/monailabel:latest
  container_name: medical-monailabel
  ports:
    - "8000:8000"
  environment:
    - MONAI_LABEL_STUDIES=http://orthanc:8042/dicom-web
    - MONAI_LABEL_APP=radiology
    - MONAI_LABEL_MODELS=deepedit
    - CUDA_VISIBLE_DEVICES=-1  # CPU mode for your AMD setup
    - OMP_NUM_THREADS=16
  volumes:
    - monailabel-models:/app/model
    - ./MONAILabel/sample-apps:/app
  command: >
    monailabel start_server
    --app /app/radiology
    --studies http://orthanc:8042/dicom-web
    --conf models deepedit
  networks:
    - medical-net
  depends_on:
    - orthanc
```

---

## 6. Presentation Flow

### Opening (2 min)
- Problem: Manual annotation is time-consuming (4-8 hours per CT)
- Solution: AI-assisted annotation with active learning

### Architecture Overview (3 min)
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   OHIF v3   │────▶│   Orthanc   │────▶│ MONAI Label │
│   Viewer    │◀────│    PACS     │◀────│   Server    │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       │              DICOMweb            REST API
       │                   │                   │
       └───────────────────┴───────────────────┘
                    Your UAA Platform
```

### Live Demo (10-15 min)

**Demo 1: Automated Segmentation**
1. Select CT study in OHIF
2. Click "Run" on MONAI Label panel
3. Show segmentation result in < 30 seconds
4. Toggle overlay visualization

**Demo 2: Interactive Refinement (DeepEdit)**
1. Show initial AI prediction
2. Add foreground click (green point)
3. Add background click (red point)
4. Watch real-time refinement
5. Submit final label

**Demo 3: Active Learning Cycle**
1. Submit corrected label
2. Click "Train" to start fine-tuning
3. Load next sample
4. Show improved prediction

### Key Metrics to Highlight (2 min)
- Annotation time: 4 hours → 15 minutes (95% reduction)
- Initial model accuracy: ~85% Dice
- After 10 annotations: ~92% Dice
- After 20 annotations: ~95% Dice

### Closing (2 min)
- Commercial viability for research labs
- Extensibility with MONAI Model Zoo
- Real-time collaboration integration (your unique feature)

---

## 7. Troubleshooting Tips

### Common Issues

**MONAI Label not connecting to Orthanc:**
```bash
# Check DICOMweb endpoint
curl http://localhost:8042/dicom-web/studies

# Verify CORS headers in orthanc.json
"HttpServerAllowedOrigins": ["*"]
```

**Model download fails:**
```bash
# Check network inside container
docker exec medical-monailabel ping github.com

# Manual model download
docker exec -it medical-monailabel bash
cd /app/radiology/model
wget <model_url>
```

**Slow inference on CPU:**
- Use `--conf preload true` to load model at startup
- Reduce batch size in configs
- Use lighter models (segmentation_spleen vs wholeBody)

**OHIF doesn't show MONAI panel:**
- Verify MONAI Label extension is enabled
- Check console for CORS errors
- Confirm server URL in extension config

### Performance Optimization

```bash
# For your AMD Ryzen HX 370 with 96GB RAM
export OMP_NUM_THREADS=16
export MKL_NUM_THREADS=16

# Consider using ONNX Runtime for faster CPU inference
pip install onnxruntime
```

---

## Quick Reference Commands

```bash
# List available apps
monailabel apps

# List available datasets
monailabel datasets

# Start with local data
monailabel start_server --app radiology --studies /path/to/data --conf models deepedit

# Start with DICOMweb (Orthanc)
monailabel start_server --app radiology --studies http://orthanc:8042/dicom-web --conf models deepedit

# Start with multiple models
monailabel start_server --app radiology --studies /data --conf models "deepedit,segmentation"

# Use MONAIBundle with Model Zoo
monailabel start_server --app monaibundle --studies /data --conf models swin_unetr_btcv_segmentation
```

---

## Resources

- [MONAI Label Documentation](https://docs.monai.io/projects/label/en/latest/)
- [MONAI Model Zoo](https://monai.io/model-zoo.html)
- [OHIF MONAI Extension](https://github.com/Project-MONAI/MONAILabel/tree/main/plugins/ohif)
- [Tutorial: OHIF + Orthanc + MONAI Label](https://github.com/Project-MONAI/tutorials/blob/main/monailabel/monailabel_radiology_spleen_segmentation_OHIF.ipynb)
- [DeepEdit Paper](https://arxiv.org/pdf/2203.12362.pdf)

---

*Generated for the Uncertainty Annotation Apparatus (UAA) - MONAI Label Integration Demo*
