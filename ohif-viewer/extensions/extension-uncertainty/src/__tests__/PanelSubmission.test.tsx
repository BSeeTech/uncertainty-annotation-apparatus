import React from 'react';
import { act } from 'react-dom/test-utils';
import ReactDOM from 'react-dom';
import { PanelSubmission } from '../panels/PanelSubmission';
import type { UncertaintyState } from '../services/UncertaintyService';

function makeState(condition: 'C0' | 'C1' | 'C2'): UncertaintyState {
  return {
    session: { reviewerId: 'R01', condition },
    currentCase: { caseId: 'case_001', inference: null },
    aiSegmentation: {
      isLoading: false,
      error: null,
      segmentationId: condition === 'C0' ? null : 'seg-ai',
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
    submitAnnotation: jest.fn().mockResolvedValue({}),
  };

  act(() => {
    ReactDOM.render(<PanelSubmission service={service as any} />, host);
  });

  return { host, service };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PanelSubmission click actions', () => {
  it.each(['C0', 'C1', 'C2'] as const)(
    '%s shows the requested no-case guidance before a worklist case is open',
    condition => {
      const { host } = renderPanel(condition, { hasCase: false });
      expect(host.textContent).toContain(
        'No case is open. Select a case from the Uncertainty Worklist, or open the mode with &caseId=... in the URL.',
      );
    },
  );

  it('C0 disables accept but submits edited manual annotation and reject decisions', () => {
    const { host, service } = renderPanel('C0');

    const accept = host.querySelector('[data-testid="submit-accept"]') as HTMLButtonElement;
    const edited = host.querySelector('[data-testid="submit-edited"]') as HTMLButtonElement;
    const rejectToggle = host.querySelector('[data-testid="submit-reject-toggle"]') as HTMLButtonElement;

    expect(accept.disabled).toBe(true);
    expect(edited.disabled).toBe(false);
    expect(rejectToggle.disabled).toBe(false);

    act(() => {
      edited.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(service.submitAnnotation).toHaveBeenCalledWith({ status: 'edited' });

    act(() => {
      rejectToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const confirm = host.querySelector('[data-testid="submit-reject-confirm"]') as HTMLButtonElement;
    act(() => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(service.submitAnnotation).toHaveBeenCalledWith({
      status: 'rejected',
      reason: undefined,
    });
  });

  it('C1 accepts the AI mask and submits edited annotations once the MONAILabel mask is ready', () => {
    const { host, service } = renderPanel('C1');

    const accept = host.querySelector('[data-testid="submit-accept"]') as HTMLButtonElement;
    const edited = host.querySelector('[data-testid="submit-edited"]') as HTMLButtonElement;

    expect(accept.disabled).toBe(false);
    expect(edited.disabled).toBe(false);

    act(() => {
      accept.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      edited.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(service.submitAnnotation).toHaveBeenCalledWith({ status: 'accepted' });
    expect(service.submitAnnotation).toHaveBeenCalledWith({ status: 'edited' });
  });

  it('C2 accepts the AI mask and submits edited annotations with uncertainty enabled', () => {
    const { host, service } = renderPanel('C2');

    const accept = host.querySelector('[data-testid="submit-accept"]') as HTMLButtonElement;
    const edited = host.querySelector('[data-testid="submit-edited"]') as HTMLButtonElement;

    expect(accept.disabled).toBe(false);
    expect(edited.disabled).toBe(false);

    act(() => {
      accept.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      edited.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(service.submitAnnotation).toHaveBeenCalledWith({ status: 'accepted' });
    expect(service.submitAnnotation).toHaveBeenCalledWith({ status: 'edited' });
  });

  it('C2 shows the MONAILabel AI mask status because it combines AI and uncertainty', () => {
    const { host } = renderPanel('C2');

    expect(host.querySelector('[data-testid="ai-mask-status"]')).not.toBeNull();
    expect(host.textContent).toContain('MONAILabel AI mask imported and editable.');
  });
});
