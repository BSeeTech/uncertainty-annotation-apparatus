import {
  buildOpenPlan,
  executeOpen,
  openUncertaintyCase,
  type OpenCaseHost,
  type OpenPlan,
} from '../commands/openUncertaintyCase';
import type { Condition, WorklistEntry } from '@thesis/extension-uncertainty';

const ENTRY: WorklistEntry = {
  case_id: 'case_001',
  patient_id: 'PAT001',
  study_uid: '1.2.3.4',
  series_uid: '1.2.3.4.5',
  score: 0.42,
  score_band: 'high',
  status: 'pending',
};

// ---------------------------------------------------------------------------
// buildOpenPlan
// ---------------------------------------------------------------------------

describe('buildOpenPlan', () => {
  it('builds a C2 plan with inference + heatmap on', () => {
    const plan = buildOpenPlan({
      caseId: 'case_001',
      entry: ENTRY,
      condition: 'C2',
    });
    expect(plan).toEqual({
      caseId: 'case_001',
      studyInstanceUID: '1.2.3.4',
      seriesInstanceUID: '1.2.3.4.5',
      runInference: true,
      importAiSegmentation: true,
      attachHeatmap: true,
    });
  });

  it('builds a C1 plan with inference but no heatmap attachment', () => {
    const plan = buildOpenPlan({
      caseId: 'case_001',
      entry: ENTRY,
      condition: 'C1',
    }) as OpenPlan;
    expect(plan.runInference).toBe(true);
    expect(plan.importAiSegmentation).toBe(true);
    expect(plan.attachHeatmap).toBe(false);
  });

  it('builds a C0 plan that skips inference and heatmap entirely', () => {
    const plan = buildOpenPlan({
      caseId: 'case_001',
      entry: ENTRY,
      condition: 'C0',
    }) as OpenPlan;
    expect(plan.runInference).toBe(false);
    expect(plan.importAiSegmentation).toBe(false);
    expect(plan.attachHeatmap).toBe(false);
  });

  it('returns no_session error when condition is null', () => {
    const result = buildOpenPlan({
      caseId: 'case_001',
      entry: ENTRY,
      condition: null,
    });
    expect(result).toEqual({ kind: 'no_session' });
  });

  it('returns invalid_condition for an unrecognised condition string', () => {
    const result = buildOpenPlan({
      caseId: 'case_001',
      entry: ENTRY,
      condition: 'C9' as unknown as Condition,
    });
    expect(result).toMatchObject({ kind: 'invalid_condition', condition: 'C9' });
  });

  it('returns unknown_case when no worklist entry was found', () => {
    const result = buildOpenPlan({
      caseId: 'nope',
      entry: null,
      condition: 'C2',
    });
    expect(result).toEqual({ kind: 'unknown_case' });
  });
});

// ---------------------------------------------------------------------------
// executeOpen
// ---------------------------------------------------------------------------

class StubUncertaintyService {
  setSession = jest.fn();
  closeCase = jest.fn();
  refreshWorklist = jest.fn();
  openCase = jest.fn().mockResolvedValue({ case_id: 'case_001' });
  openManualCase = jest.fn().mockResolvedValue(undefined);
  getState = jest.fn();
  subscribe = jest.fn();
  applySessionFromQuery = jest.fn();
  setWorklistPolicy = jest.fn();
  setHeatmapVisible = jest.fn();
  toggleHeatmap = jest.fn();
  setHeatmapOpacity = jest.fn();
  acceptCurrent = jest.fn();
  rejectCurrent = jest.fn();
  escalateCurrent = jest.fn();
}

function buildStubHost(overrides: Partial<OpenCaseHost> = {}): OpenCaseHost {
  const svc = new StubUncertaintyService();
  return {
    getWorklistEntry: () => ENTRY,
    getCondition: () => 'C2' as Condition,
    servicesManager: { services: { uncertaintyService: svc as any } },
    loadStudy: jest.fn().mockResolvedValue(undefined),
    resolveImageVolumeId: jest.fn().mockResolvedValue('vol:image'),
    resolveActiveViewportIds: jest.fn().mockReturnValue(['vp1']),
    ...overrides,
  };
}

describe('executeOpen', () => {
  it('C2: loads study, resolves volume, opens case via UncertaintyService', async () => {
    const host = buildStubHost();
    const plan: OpenPlan = {
      caseId: 'case_001',
      studyInstanceUID: '1.2.3.4',
      seriesInstanceUID: '1.2.3.4.5',
      runInference: true,
      importAiSegmentation: true,
      attachHeatmap: true,
    };
    await executeOpen(plan, host);
    expect(host.loadStudy).toHaveBeenCalledWith({
      studyInstanceUID: '1.2.3.4',
      seriesInstanceUID: '1.2.3.4.5',
    });
    expect(host.resolveImageVolumeId).toHaveBeenCalledWith('1.2.3.4.5');
    expect(host.servicesManager.services.uncertaintyService.openCase).toHaveBeenCalledWith({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
  });

  it('C0: loads study and marks the case current without inference', async () => {
    const host = buildStubHost();
    const plan: OpenPlan = {
      caseId: 'case_001',
      studyInstanceUID: '1.2.3.4',
      seriesInstanceUID: '1.2.3.4.5',
      runInference: false,
      importAiSegmentation: false,
      attachHeatmap: false,
    };
    await executeOpen(plan, host);
    expect(host.loadStudy).toHaveBeenCalledTimes(1);
    expect(host.resolveImageVolumeId).toHaveBeenCalledWith('1.2.3.4.5');
    expect(host.servicesManager.services.uncertaintyService.openCase).not.toHaveBeenCalled();
    expect(host.servicesManager.services.uncertaintyService.openManualCase).toHaveBeenCalledWith({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
    });
  });

  it('C0: switches the active viewport to the selected case display set', async () => {
    const setDisplaySetsForViewport = jest.fn();
    const host = buildStubHost();
    host.servicesManager.services.displaySetService = {
      getDisplaySetsForSeries: jest
        .fn()
        .mockReturnValue([{ displaySetInstanceUID: 'display-set-new' }]),
    };
    host.servicesManager.services.viewportGridService = {
      getState: jest.fn().mockReturnValue({
        viewports: new Map([['vp1', { displaySetInstanceUIDs: ['display-set-old'] }]]),
      }),
      setDisplaySetsForViewport,
    };

    await executeOpen(
      {
        caseId: 'case_001',
        studyInstanceUID: '1.2.3.4',
        seriesInstanceUID: '1.2.3.4.5',
        runInference: false,
        importAiSegmentation: false,
        attachHeatmap: false,
      },
      host
    );

    expect(setDisplaySetsForViewport).toHaveBeenCalledWith({
      viewportId: 'vp1',
      displaySetInstanceUIDs: ['display-set-new'],
    });
  });

  it('throws if no active viewports are resolved', async () => {
    const host = buildStubHost({
      resolveActiveViewportIds: () => [],
    });
    const plan: OpenPlan = {
      caseId: 'c',
      studyInstanceUID: 's',
      seriesInstanceUID: 'ss',
      runInference: true,
      importAiSegmentation: true,
      attachHeatmap: true,
    };
    await expect(executeOpen(plan, host)).rejects.toThrow(/No active viewports/);
  }, 15_000);

  it('allows inference/import to finish after the old 10-minute timeout', async () => {
    jest.useFakeTimers();
    try {
      const host = buildStubHost();
      host.servicesManager.services.uncertaintyService.openCase = jest.fn(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve({ case_id: 'case_slow' }), 1_032_000);
          })
      ) as any;
      const plan: OpenPlan = {
        caseId: 'case_slow',
        studyInstanceUID: '1.2.3.4',
        seriesInstanceUID: '1.2.3.4.5',
        runInference: true,
        importAiSegmentation: true,
        attachHeatmap: true,
      };

      const openPromise = executeOpen(plan, host);
      await jest.advanceTimersByTimeAsync(1_032_000);

      await expect(openPromise).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// openUncertaintyCase (top-level)
// ---------------------------------------------------------------------------

describe('openUncertaintyCase', () => {
  const originalWindow = global.window;

  afterEach(() => {
    Object.defineProperty(global, 'window', {
      value: originalWindow,
      configurable: true,
    });
  });

  it('happy path: builds plan and executes', async () => {
    const host = buildStubHost();
    await openUncertaintyCase({ caseId: 'case_001' }, host);
    expect(host.servicesManager.services.uncertaintyService.openCase).toHaveBeenCalled();
  });

  it('updates the URL caseId and case_id after a worklist case is opened', async () => {
    const replaceState = jest.fn();
    Object.defineProperty(global, 'window', {
      value: {
        location: {
          href: 'http://localhost/uncertainty-review?reviewer=R01&condition=C2',
        },
        history: { replaceState },
      },
      configurable: true,
    });

    const host = buildStubHost();
    await openUncertaintyCase({ caseId: 'case_001' }, host);

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      'http://localhost/uncertainty-review?reviewer=R01&condition=C2&caseId=case_001&case_id=case_001'
    );
  });

  it('replaces existing URL caseId and case_id when another worklist case is opened', async () => {
    const replaceState = jest.fn();
    Object.defineProperty(global, 'window', {
      value: {
        location: {
          href: 'http://localhost/uncertainty-review?reviewer=R01&condition=C2&caseId=old_case',
        },
        history: { replaceState },
      },
      configurable: true,
    });

    const host = buildStubHost();
    await openUncertaintyCase({ caseId: 'case_001' }, host);

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      'http://localhost/uncertainty-review?reviewer=R01&condition=C2&caseId=case_001&case_id=case_001'
    );
  });

  it('refuses to open when no condition is set', async () => {
    const host = buildStubHost({ getCondition: () => null });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(openUncertaintyCase({ caseId: 'case_001' }, host)).rejects.toThrow(/no_session/);
    warn.mockRestore();
  });

  it('refuses to open an unknown case', async () => {
    const host = buildStubHost({ getWorklistEntry: () => null });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(openUncertaintyCase({ caseId: 'mystery' }, host)).rejects.toThrow(/unknown_case/);
    warn.mockRestore();
  });

  it('refuses to open with an invalid condition', async () => {
    const host = buildStubHost({
      getCondition: () => 'C9' as unknown as Condition,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(openUncertaintyCase({ caseId: 'case_001' }, host)).rejects.toThrow(
      /invalid_condition/
    );
    warn.mockRestore();
  });
});
