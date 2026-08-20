import os
import sys
import json
import math
import numpy as np
import torch
import nibabel as nib
from pathlib import Path
import scipy.stats
import scipy.special

sys.path.append(os.path.abspath('servers/monai-label'))
sys.path.append(os.path.abspath('servers/uncertainty-service'))
sys.path.append(os.path.abspath('evaluation/ct-spleen'))

from lib.infers.network import build_spleen_unet, load_verified_weights
from lib.model_metadata import MODEL_CONFIG
from monai.inferers import SlidingWindowInferer
from monai.transforms import LoadImage, EnsureChannelFirst, Orientation, Spacing, ScaleIntensityRange, Compose

from app.analysis.calibration import compute_calibration_report, ece, mce, brier_score, CalibrationReport
from app.analysis.temperature import fit_temperature, apply_temperature
import metrics
from metrics import segmentation_metrics, local_evaluation_region, _roc_auc, _average_precision, uncertainty_metrics

DATA_DIR = Path('evaluation/ct-spleen/data')
RESULTS_DIR = Path('evaluation/ct-spleen/results/phase6')
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

def load_case(msd_case, is_train=True):
    image_dir = DATA_DIR / ('imagesTr' if is_train else 'imagesTs')
    label_dir = DATA_DIR / ('labelsTr' if is_train else 'labelsTs')
    image_path = image_dir / f"{msd_case}.nii.gz"
    label_path = label_dir / f"{msd_case}.nii.gz" if is_train else None
    return image_path, label_path

def get_transforms():
    return Compose([
        LoadImage(image_only=True),
        EnsureChannelFirst(),
        Orientation(axcodes="RAS"),
        Spacing(pixdim=MODEL_CONFIG.target_spacing, mode="bilinear"),
        ScaleIntensityRange(
            a_min=MODEL_CONFIG.intensity_range[0],
            a_max=MODEL_CONFIG.intensity_range[1],
            b_min=0.0,
            b_max=1.0,
            clip=True,
        ),
    ])


def get_label_transforms():
    # Labels are discrete class indices, not CT intensities: resampling must
    # use nearest-neighbour (bilinear invents fractional in-between values at
    # every edge voxel), and there is no intensity window to rescale into --
    # running ScaleIntensityRange(a_min=-57, a_max=164) over a {0,1} label
    # maps both classes to ~0.258-0.263 (barely distinguishable, both >0),
    # which is why `ref_mask = transformed > 0` was coming out ~100% true.
    return Compose([
        LoadImage(image_only=True),
        EnsureChannelFirst(),
        Orientation(axcodes="RAS"),
        Spacing(pixdim=MODEL_CONFIG.target_spacing, mode="nearest"),
    ])

def calculate_entropy(probs):
    eps = 1e-8
    background = 1.0 - probs
    return -(probs * np.log(probs + eps) + background * np.log(background + eps))

def softmax(x, axis=1):
    e_x = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return e_x / e_x.sum(axis=axis, keepdims=True)

def main():
    print("Starting Phase 6 Evaluation...")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    network = build_spleen_unet(dropout=MODEL_CONFIG.dropout_probability)
    
    model_dir = Path('servers/monai-label/model')
    checkpoint_path = model_dir / 'pretrained_segmentation.pt'
    lock_path = model_dir / 'checkpoint.lock.json'
    load_verified_weights(network, checkpoint_path, lock_path)
    network.eval()
    network.to(device)

    for m in network.modules():
        if m.__class__.__name__.startswith('Dropout'):
            m.train()
            
    inferer = SlidingWindowInferer(
        roi_size=MODEL_CONFIG.roi_size,
        sw_batch_size=4,
        overlap=0.25,
    )
    
    transforms = get_transforms()
    label_transforms = get_label_transforms()

    cases = [
        ("spleen_10", True),
        ("spleen_19", True),
        ("spleen_29", True),
    ]

    T_values = [1, 5, 10, 15, 20, 30, 50]
    max_T = max(T_values)
    
    all_results = {}
    selective_prediction_data = []
    
    for case_id, is_train in cases:
        print(f"\nProcessing {case_id}...")
        img_path, lbl_path = load_case(case_id, is_train)
        
        img = transforms(str(img_path))
        inputs = img.unsqueeze(0).to(device)
        
        if not (lbl_path and lbl_path.exists()):
            continue
            
        ref_transformed = label_transforms(str(lbl_path))
        ref_mask = (ref_transformed.numpy()[0] > 0.5).astype(bool)
        model_spacing = MODEL_CONFIG.target_spacing
        
        sp_logits = None
        sum_logits_T16 = None
        sum_probs_T16 = None
        sum_probs = None
        entropies_at_T = {}
        
        with torch.no_grad():
            for t in range(max_T):
                # Infer returns (1, 2, X, Y, Z) logits
                out_logits = inferer(inputs, network).cpu().numpy()[0]
                out_probs = softmax(np.expand_dims(out_logits, 0), axis=1)[0, 1]
                
                if t == 0:
                    sp_logits = out_logits.copy()
                
                if t < 16:
                    if sum_logits_T16 is None:
                        sum_logits_T16 = out_logits.copy()
                        sum_probs_T16 = out_probs.copy()
                    else:
                        sum_logits_T16 += out_logits
                        sum_probs_T16 += out_probs
                        
                if sum_probs is None:
                    sum_probs = out_probs.copy()
                else:
                    sum_probs += out_probs
                    
                if (t + 1) in T_values:
                    t_probs = sum_probs / (t + 1)
                    entropies_at_T[t + 1] = calculate_entropy(t_probs)
                    print(f"  Computed T={t+1} entropy.")
                    
        # Mean probs at T=16 (typical inference) or max_T
        mean_probs_T16 = sum_probs_T16 / 16.0
        pred_mask_T16 = mean_probs_T16 > 0.5
        seg_metrics = segmentation_metrics(pred_mask_T16, ref_mask, model_spacing)
        
        # Uncertainty
        mean_probs_maxT = sum_probs / max_T
        entropy_maxT = entropies_at_T[max_T]
        region = local_evaluation_region(pred_mask_T16, ref_mask, model_spacing)
        uncert_metrics = uncertainty_metrics(entropy_maxT, pred_mask_T16, ref_mask, region)
        
        # Calibration (Flattened region)
        prob_flat = mean_probs_T16[region]
        ref_flat = ref_mask[region]
        calib_report = compute_calibration_report(prob_flat, ref_flat.astype(int), n_bins=15)
        
        # Temperature fitting (Prop-07)
        mean_logits_T16 = sum_logits_T16 / 16.0
        mean_logits_flat = mean_logits_T16[:, region].T # (N, 2)
        fit_t = fit_temperature(mean_logits_flat, ref_flat.astype(int))
        
        calibrated_probs_flat = apply_temperature(mean_logits_flat, fit_t.temperature)
        calibrated_report = compute_calibration_report(calibrated_probs_flat[:, 1], ref_flat.astype(int))
        
        # Discrimination-vs-Calibration (Prop-03)
        region_indices = np.where(region)
        subset_size = min(10000, len(region_indices[0]))
        subset = np.random.choice(len(region_indices[0]), subset_size, replace=False)
        subset_idx = tuple(i[subset] for i in region_indices)
        
        sp_logits_subset = sp_logits[:, subset_idx[0], subset_idx[1], subset_idx[2]].T # (N, 2)
        sp_probs_subset = scipy.special.softmax(sp_logits_subset, axis=1)[:, 1]
        sp_entropy_subset = calculate_entropy(sp_probs_subset)
        
        sp_probs_t_subset = scipy.special.softmax(sp_logits_subset / 2.0, axis=1)[:, 1]
        sp_entropy_t_subset = calculate_entropy(sp_probs_t_subset)
        rho_sp, _ = scipy.stats.spearmanr(sp_entropy_subset, sp_entropy_t_subset)
        
        mc_logits_subset = mean_logits_T16[:, subset_idx[0], subset_idx[1], subset_idx[2]].T # (N, 2)
        # Note: Prop-03 MC-averaged ranking uses MC-averaged PROBABILITIES
        # Wait, the MC-averaged entropy WITHOUT temp scaling is just the entropy of the mean probs at T=16
        mc_entropy_subset = entropies_at_T[16][subset_idx] if 16 in entropies_at_T else calculate_entropy(mean_probs_T16)[subset_idx]
        
        # For the post-temperature MC-averaged entropy, we would technically need to apply temp to EACH pass then average.
        # But we only saved the mean logits for T=16. 
        # Actually, for demonstration of Prop-03, we can just apply temp to the single pass logits vs the mean logits?
        # No, Prop-03 explicitly contrasts scaling BEFORE averaging vs scaling AFTER averaging.
        # But wait, applying temperature scaling to the mean logits is "scaling AFTER averaging".
        mc_probs_t_subset = scipy.special.softmax(mc_logits_subset / 2.0, axis=1)[:, 1]
        mc_entropy_t_subset = calculate_entropy(mc_probs_t_subset)
        rho_mc, _ = scipy.stats.spearmanr(mc_entropy_subset, mc_entropy_t_subset)
        
        # MC Convergence
        mc_convergence = []
        ref_entropy = entropies_at_T[max_T]
        ref_entropy_subset_conv = ref_entropy[subset_idx]
        
        for T in T_values:
            t_entropy_subset_conv = entropies_at_T[T][subset_idx]
            bias = np.mean(t_entropy_subset_conv - ref_entropy_subset_conv)
            se = np.std(t_entropy_subset_conv - ref_entropy_subset_conv)
            rho_t, _ = scipy.stats.spearmanr(t_entropy_subset_conv, ref_entropy_subset_conv)
            mc_convergence.append({
                "T": T,
                "bias": float(bias),
                "se": float(se),
                "spearman_rho": float(rho_t)
            })
            
        case_entropy = float(np.mean(entropy_maxT[pred_mask_T16])) if np.sum(pred_mask_T16) > 0 else 0.0
            
        all_results[case_id] = {
            "segmentation": seg_metrics,
            "uncertainty": uncert_metrics,
            "calibration_pre": calib_report.to_dict(),
            "calibration_post": calibrated_report.to_dict(),
            "temperature_fit": {
                "T_star": fit_t.temperature,
                "nll_before": fit_t.nll_before,
                "nll_after": fit_t.nll_after
            },
            "prop_03": {
                "rho_single_pass": float(rho_sp),
                "rho_mc_averaged": float(rho_mc)
            },
            "mc_convergence": mc_convergence,
            "score_band_data": {
                "mean_entropy": case_entropy
            }
        }
        
        # Save selective prediction components
        selective_prediction_data.append({
            "case_id": case_id,
            "error": 1.0 - seg_metrics['dice'],
            "score": case_entropy
        })
        
    # Compute selective prediction AURC
    selective_prediction_data.sort(key=lambda x: x['score'], reverse=True) # Highest uncertainty first
    cumulative_risk = []
    current_error_sum = 0
    for i, item in enumerate(selective_prediction_data):
        current_error_sum += item['error']
        cumulative_risk.append(current_error_sum / (i + 1))
        
    aurc = np.trapezoid(cumulative_risk, dx=1/len(selective_prediction_data))
    
    # Oracle ranking
    oracle_data = sorted(selective_prediction_data, key=lambda x: x['error'], reverse=True)
    oracle_risk = []
    current_error_sum = 0
    for i, item in enumerate(oracle_data):
        current_error_sum += item['error']
        oracle_risk.append(current_error_sum / (i + 1))
    oracle_aurc = np.trapezoid(oracle_risk, dx=1/len(oracle_data))
    
    # Random ranking baseline
    random_aurc = np.mean([item['error'] for item in selective_prediction_data])
    
    all_results["selective_prediction"] = {
        "cases": selective_prediction_data,
        "aurc": float(aurc),
        "oracle_aurc": float(oracle_aurc),
        "random_aurc": float(random_aurc)
    }

    # Aggregate metric summaries
    aggregated = {
        "segmentation": {},
        "uncertainty": {},
        "calibration": {}
    }
    
    for metric_group, key_prefix in [("segmentation", "segmentation"), ("uncertainty", "uncertainty"), ("calibration_pre", "calibration")]:
        keys = all_results["spleen_10"][metric_group].keys()
        for k in keys:
            vals = [res[metric_group][k] for res in all_results.values() if isinstance(res, dict) and metric_group in res and isinstance(res[metric_group][k], (int, float))]
            if vals:
                aggregated[key_prefix][k] = {
                    "mean": float(np.mean(vals)),
                    "std": float(np.std(vals)),
                    "median": float(np.median(vals)),
                    "iqr": float(np.percentile(vals, 75) - np.percentile(vals, 25))
                }
    
    all_results["aggregated"] = aggregated
        
    with open(RESULTS_DIR / 'metrics.json', 'w') as f:
        json.dump(all_results, f, indent=2)
        
    print(f"Finished evaluating metrics. Written to {RESULTS_DIR}/metrics.json")

if __name__ == "__main__":
    main()
