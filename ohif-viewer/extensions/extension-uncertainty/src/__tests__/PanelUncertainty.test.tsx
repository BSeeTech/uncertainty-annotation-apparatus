import React from 'react';
import { act, Simulate } from 'react-dom/test-utils';
import ReactDOM from 'react-dom';
import { PanelUncertainty } from '../panels/PanelUncertainty';
import type { UncertaintyState } from '../services/UncertaintyService';

function makeState(condition: 'C0' | 'C1' | 'C2'): UncertaintyState {
  return {
    session: { reviewerId: 'R01', condition },
    currentCase: {
      caseId: 'case_001',
      inference: condition === 'C2'
        ? {
            case_id: 'case_001',
            segmentation_url: '/seg.nii.gz',
            uncertainty_url: '/entropy.nii.gz',
            model_version: 'mcdropout_seg',
            checkpoint_version: 'pretrained/radiology_segmentation_unet_spleen_total_seg.pt',
            checkpoint_sha256: 'b606697f',
            num_samples: 16,
            dropout_probability: 0.2,
            score: 0.42,
            score_p95: 0.7,
            score_fraction_above: 0.2,
            score_mean_all: 0.1,
            threshold: 0.5,
            band: 'high',
            inference_status: 'completed',
            metrics_version: 'ct-spleen-v1',
            artifact_generation: 'generation-001',
            result_url: '/results/case_001?condition=C2',
            cache_hit: true,
          }
        : null,
    },
    aiSegmentation: {
      isLoading: false,
      error: null,
      segmentationId: null,
    },
    heatmap: {
      visible: false,
      opacity: 0.6,
      maxEntropy: Math.log(2),
    },
    worklist: {
      items: [],
      policy: 'fifo',
      isLoading: false,
      error: null,
    },
    submission: {
      isSubmitting: false,
      error: null,
      lastOutcome: null,
    },
  };
}

function renderPanel(
  condition: 'C0' | 'C1' | 'C2',
  opts: { hasCase?: boolean } = {},
) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const state = makeState(condition);
  if (opts.hasCase === false) {
    state.currentCase = null;
  }
  const service = {
    getState: () => state,
    subscribe: () => () => undefined,
    toggleHeatmap: jest.fn(),
    setHeatmapOpacity: jest.fn(),
  };

  act(() => {
    ReactDOM.render(<PanelUncertainty service={service as any} />, host);
  });

  return { host, service };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PanelUncertainty controls', () => {
  it('C2 shows the requested no-case guidance before a worklist case is open', () => {
    const { host } = renderPanel('C2', { hasCase: false });
    expect(host.textContent).toContain(
      'No case is open. Select a case from the Uncertainty Worklist, or open the mode with &caseId=... in the URL.',
    );
  });

  it('C0/C1 render disabled heatmap actions', () => {
    for (const condition of ['C0', 'C1'] as const) {
      const { host } = renderPanel(condition);
      const toggle = host.querySelector('[data-testid="heatmap-toggle"]') as HTMLButtonElement;
      const opacity = host.querySelector('[data-testid="heatmap-opacity"]') as HTMLInputElement;
      expect(toggle.disabled).toBe(true);
      expect(opacity.disabled).toBe(true);
      document.body.innerHTML = '';
    }
  });

  it('C2 toggles the heatmap and sends opacity changes to the service', () => {
    const { host, service } = renderPanel('C2');
    const toggle = host.querySelector('[data-testid="heatmap-toggle"]') as HTMLButtonElement;
    const opacity = host.querySelector('[data-testid="heatmap-opacity"]') as HTMLInputElement;

    expect(toggle.disabled).toBe(false);
    expect(opacity.disabled).toBe(false);

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(service.toggleHeatmap).toHaveBeenCalled();

    act(() => {
      opacity.value = '0.25';
      Simulate.change(opacity);
    });
    expect(service.setHeatmapOpacity).toHaveBeenCalledWith(0.25);

    act(() => {
      (host.querySelector('[data-testid="heatmap-opacity-0"]') as HTMLButtonElement).click();
      (host.querySelector('[data-testid="heatmap-opacity-50"]') as HTMLButtonElement).click();
      (host.querySelector('[data-testid="heatmap-opacity-100"]') as HTMLButtonElement).click();
    });
    expect(service.setHeatmapOpacity).toHaveBeenCalledWith(0);
    expect(service.setHeatmapOpacity).toHaveBeenCalledWith(0.5);
    expect(service.setHeatmapOpacity).toHaveBeenCalledWith(1);
  });

  it('shows authoritative checkpoint provenance and T=16', () => {
    const { host } = renderPanel('C2');
    const footer = host.querySelector('[data-testid="model-version"]');

    expect(footer?.textContent).toContain(
      'pretrained/radiology_segmentation_unet_spleen_total_seg.pt',
    );
    expect(footer?.textContent).toContain('T=16');
  });
});
