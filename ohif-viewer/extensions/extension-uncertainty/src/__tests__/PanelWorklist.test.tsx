import React from 'react';
import { act } from 'react-dom/test-utils';
import ReactDOM from 'react-dom';
import { PanelWorklist } from '../panels/PanelWorklist';
import type { UncertaintyState } from '../services/UncertaintyService';

const state: UncertaintyState = {
  session: { reviewerId: 'R01', condition: 'C2' },
  worklist: {
    items: [],
    policy: 'fifo',
    isLoading: false,
    error: null,
  },
  currentCase: null,
  heatmap: {
    visible: false,
    opacity: 0.35,
    maxEntropy: Math.log(2),
  },
  submission: {
    isSubmitting: false,
    error: null,
    lastOutcome: null,
  },
};

describe('PanelWorklist lifecycle refresh', () => {
  it('contains refresh failures from the mount effect', () => {
    const catchSpy = jest.fn();
    const refreshResult = {
      catch: catchSpy,
    };
    const service = {
      getState: () => state,
      subscribe: () => () => undefined,
      refreshWorklist: jest.fn(() => refreshResult),
      setWorklistPolicy: jest.fn(),
    };
    const host = document.createElement('div');

    act(() => {
      ReactDOM.render(
        <PanelWorklist
          service={service as any}
          onOpenCase={jest.fn()}
        />,
        host,
      );
    });

    expect(service.refreshWorklist).toHaveBeenCalled();
    expect(catchSpy).toHaveBeenCalledWith(expect.any(Function));

    act(() => {
      ReactDOM.unmountComponentAtNode(host);
    });
  });

  it('marks the selected case failed when the async open command rejects', async () => {
    const caseId = 'case_001';
    const openError = new Error('volume resolution timed out');
    const selectCase = jest.fn();
    const markCaseOpenFailed = jest.fn();
    const service = {
      getState: () => ({
        ...state,
        worklist: {
          ...state.worklist,
          items: [
            {
              case_id: caseId,
              study_uid: 'study_001',
              series_uid: 'series_001',
              score: 0.123,
              score_band: 'high',
              status: 'ready',
            },
          ],
        },
      }),
      subscribe: () => () => undefined,
      refreshWorklist: jest.fn(() => Promise.resolve()),
      setWorklistPolicy: jest.fn(),
      selectCase,
      markCaseOpenFailed,
    };
    const host = document.createElement('div');

    await act(async () => {
      ReactDOM.render(
        <PanelWorklist
          service={service as any}
          onOpenCase={jest.fn(() => Promise.reject(openError))}
        />,
        host,
      );
    });

    await act(async () => {
      host
        .querySelector(`[data-testid="worklist-item-${caseId}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(selectCase).toHaveBeenCalledWith({ caseId });
    expect(markCaseOpenFailed).toHaveBeenCalledWith({
      caseId,
      error: openError.message,
    });

    act(() => {
      ReactDOM.unmountComponentAtNode(host);
    });
  });
});
