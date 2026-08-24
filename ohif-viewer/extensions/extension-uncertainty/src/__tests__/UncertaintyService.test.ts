import { UncertaintyService } from '../services/UncertaintyService';
import type {
  EventPayload,
  InferenceResult,
  WorklistEntry,
  WorklistPolicy,
} from '../types';
import type { SubmissionOutcome, SubmissionStatus } from '../services/SubmissionApi';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubApi {
  inference: InferenceResult = {
    case_id: 'case_001',
    segmentation_url: '/seg.nii.gz',
    uncertainty_url: '/ent.nii.gz',
    model_version: 'mcdropout_seg_v1',
    checkpoint_version: 'pretrained/radiology_segmentation_unet_spleen_total_seg.pt',
    checkpoint_sha256: 'b606697f',
    num_samples: 16,
    dropout_probability: 0.2,
    score: 0.42,
    score_p95: 0.61,
    score_fraction_above: 0.20,
    score_mean_all: 0.10,
    threshold: 0.5,
    band: 'high',
    inference_status: 'completed',
    metrics_version: 'ct-spleen-v1',
    artifact_generation: 'generation-001',
    result_url: '/results/case_001?condition=C2',
    cache_hit: true,
  };
  worklistResponses: WorklistEntry[][] = [];
  worklistShouldFail = false;
  inferenceShouldFail = false;
  postedEvents: EventPayload[][] = [];
  worklistRequests: { policy: WorklistPolicy }[] = [];
  inferenceRequests: string[] = [];

  async getWorklist(opts: { policy: WorklistPolicy }): Promise<WorklistEntry[]> {
    this.worklistRequests.push(opts);
    if (this.worklistShouldFail) throw new Error('boom');
    return this.worklistResponses.shift() ?? [];
  }
  async runInference(caseId: string): Promise<InferenceResult> {
    this.inferenceRequests.push(caseId);
    if (this.inferenceShouldFail) throw new Error('infer failed');
    return { ...this.inference, case_id: caseId };
  }
  async postEvents(events: EventPayload[]): Promise<number> {
    this.postedEvents.push([...events]);
    return events.length;
  }
  postEventsBeacon(): boolean { return true; }
}

class StubSubmissionApi {
  statusUpdates: any[] = [];
  submissions: any[] = [];
  outcome: SubmissionOutcome = {
    case_id: 'case_001',
    reviewer_id: 'R01',
    condition: 'C2',
    storage_url: '/files/cases/case_001/annotations/R01.nii.gz',
    edit_voxel_count: 7,
    ai_foreground_voxels: 100,
    reviewer_foreground_voxels: 103,
    edit_fraction_of_ai_foreground: 0.07,
    submitted_at: new Date().toISOString(),
  };
  submitShouldFail = false;
  updateStatusShouldFail = false;

  async submit(args: any): Promise<SubmissionOutcome> {
    if (this.submitShouldFail) throw new Error('submit failed');
    this.submissions.push(args);
    return { ...this.outcome, ...args };
  }
  async updateStatus(args: any): Promise<any> {
    if (this.updateStatusShouldFail) throw new Error('updateStatus failed');
    this.statusUpdates.push(args);
    return { ...args, started_at: new Date().toISOString(), ended_at: null };
  }
  async getAnnotation(): Promise<SubmissionOutcome | null> { return null; }
}

class StubExporter {
  blobToReturn: Blob | null = new Blob(['fake-nifti-bytes'], {
    type: 'application/octet-stream',
  });
  exportShouldThrow = false;
  calls: any[] = [];

  async exportSegmentationAsNiftiBlob(args: any): Promise<Blob | null> {
    this.calls.push(args);
    if (this.exportShouldThrow) throw new Error('export failed');
    return this.blobToReturn;
  }
}


class StubSegmentationImporter {
  calls: any[] = [];
  removeCalls: any[] = [];
  importShouldThrow = false;
  result = { segmentationId: 'uncertainty:monailabel-seg:case_001' };

  async importSegmentation(args: any) {
    this.calls.push(args);
    if (this.importShouldThrow) throw new Error('import failed');
    return this.result;
  }

  async removeSegmentation(args: any): Promise<void> {
    this.removeCalls.push(args);
  }
}

class StubRenderer {
  loaded: any = null;
  visible: boolean | null = null;
  opacity: number | null = null;
  unloads = 0;
  loadShouldThrow = false;

  get currentCaseId() { return this.loaded?.caseId ?? null; }
  get currentConfig() { return this.loaded?.config ?? null; }

  async loadForCase(args: any) {
    if (this.loadShouldThrow) throw new Error('heatmap failed');
    this.loaded = { caseId: args.caseId, config: args.initialConfig ?? {} };
    return { maxEntropy: 0.5, nVoxels: 1000 };
  }
  setVisible(v: boolean) { this.visible = v; }
  setOpacity(o: number) { this.opacity = o; }
  setMaxEntropy() {}
  async unload() { this.loaded = null; this.unloads++; }
}

import { EventLogger } from '../services/EventLogger';

function buildService() {
  const api = new StubApi();
  const submissionApi = new StubSubmissionApi();
  const exporter = new StubExporter();
  const segmentationImporter = new StubSegmentationImporter();
  const logger = new EventLogger({
    api: api as any,
    installUnloadHandlers: false,
    flushIntervalMs: 50,
  });
  const renderer = new StubRenderer() as any;
  const service = new UncertaintyService({
    api: api as any,
    submissionApi: submissionApi as any,
    exporter: exporter as any,
    segmentationImporter: segmentationImporter as any,
    logger,
    renderer,
  });
  return { api, submissionApi, exporter, segmentationImporter, logger, renderer, service };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UncertaintyService — session', () => {
  it('setSession updates state and configures the EventLogger', () => {
    const { service, logger } = buildService();
    service.setSession({ reviewerId: 'R03', condition: 'C2' });
    expect(service.getState().session).toEqual({ reviewerId: 'R03', condition: 'C2' });
    // The logger's session is now set; logging should not drop.
    logger.setCurrentCase('c');
    logger.log('case_open');
    expect(logger.pendingCount).toBe(1);
  });

  it.each([
    ['C0', 'fifo'],
    ['C1', 'fifo'],
    ['C2', 'high_first'],
  ] as const)('enforces the %s worklist isolation policy', async (condition, policy) => {
    const { service, api } = buildService();
    api.worklistResponses.push([]);
    service.setSession({ reviewerId: 'R03', condition });
    await service.refreshWorklist();
    expect(service.getState().worklist.policy).toBe(policy);
    expect(api.worklistRequests.at(-1)?.policy).toBe(policy);
  });

  it('applySessionFromQuery accepts ?reviewer=&condition=', () => {
    const { service } = buildService();
    expect(service.applySessionFromQuery('?reviewer=R03&condition=C2')).toBe(true);
    expect(service.getState().session).toEqual({ reviewerId: 'R03', condition: 'C2' });
  });

  it('applySessionFromQuery rejects invalid conditions', () => {
    const { service } = buildService();
    expect(service.applySessionFromQuery('?reviewer=R03&condition=C9')).toBe(false);
    expect(service.getState().session).toBeNull();
  });

  it('applySessionFromQuery rejects missing reviewer', () => {
    const { service } = buildService();
    expect(service.applySessionFromQuery('?condition=C2')).toBe(false);
  });
});

describe('UncertaintyService — runtime dependency configuration', () => {
  it('replaces renderer, exporter, and segmentation importer after startup', async () => {
    const { service } = buildService();
    const renderer = new StubRenderer() as any;
    const exporter = new StubExporter();
    const segmentationImporter = new StubSegmentationImporter();

    service.configureRuntimeDependencies({
      renderer,
      exporter: exporter as any,
      segmentationImporter: segmentationImporter as any,
    });

    service.setSession({ reviewerId: 'R01', condition: 'C1' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });

    expect(renderer.loaded).toBeNull();
    expect(segmentationImporter.calls).toHaveLength(1);

    await service.submitAnnotation({ status: 'edited' });
    expect(exporter.calls).toHaveLength(1);
    expect(exporter.calls[0].referenceVolumeId).toBe('vol:image');
  });

  it('replaces the API used for worklist, inference, and event logging after startup', async () => {
    const { service, api } = buildService();
    const replacementApi = new StubApi();
    replacementApi.worklistResponses.push([
      { case_id: 'replacement_case', patient_id: null, study_uid: 's', series_uid: 'ss',
        score: 0.7, score_band: 'high', inference_status: null, status: 'pending' },
    ]);

    service.setSession({ reviewerId: 'R01', condition: 'C1' });
    service.configureRuntimeDependencies({ api: replacementApi as any });

    await service.refreshWorklist('fifo');
    await service.openCase({
      caseId: 'replacement_case',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await (service as any).logger.flush();

    expect(replacementApi.worklistRequests.map(req => req.policy)).toEqual(['fifo']);
    expect(replacementApi.inferenceRequests).toEqual(['replacement_case']);
    expect(replacementApi.postedEvents.flat().map(e => e.event_type)).toContain('case_open');
    expect(api.postedEvents.flat().map(e => e.case_id)).not.toContain('replacement_case');
  });
});

describe('UncertaintyService — worklist', () => {
  it('refreshWorklist populates state and toggles isLoading', async () => {
    const { service, api } = buildService();
    api.worklistResponses.push([
      { case_id: 'a', patient_id: null, study_uid: 's', series_uid: 'ss',
        score: 0.4, score_band: 'high', inference_status: null, status: 'pending' },
    ]);
    const p = service.refreshWorklist('high_first');
    expect(service.getState().worklist.isLoading).toBe(true);
    await p;
    expect(service.getState().worklist.isLoading).toBe(false);
    expect(service.getState().worklist.items).toHaveLength(1);
    expect(service.getState().worklist.policy).toBe('high_first');
  });

  it('refreshWorklist surfaces errors into state and re-throws', async () => {
    const { service, api } = buildService();
    api.worklistShouldFail = true;
    await expect(service.refreshWorklist()).rejects.toThrow();
    expect(service.getState().worklist.error).toMatch(/boom/);
  });

  it('setWorklistPolicy updates state immediately and triggers a refresh', async () => {
    const { service, api } = buildService();
    api.worklistResponses.push([]);
    service.setWorklistPolicy('low_first');
    expect(service.getState().worklist.policy).toBe('low_first');
    // wait for the async refresh
    await new Promise(r => setTimeout(r, 0));
    expect(service.getState().worklist.isLoading).toBe(false);
  });

  it('setWorklistPolicy stores refresh errors without an unhandled rejection', async () => {
    const { service, api } = buildService();
    api.worklistShouldFail = true;
    const unhandled = jest.fn();
    process.once('unhandledRejection', unhandled);

    service.setWorklistPolicy('fifo');

    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(service.getState().worklist.error).toMatch(/boom/);
    expect(service.getState().worklist.isLoading).toBe(false);
  });
});

describe('UncertaintyService — case lifecycle by condition', () => {
  it('C2: openCase imports the MONAILabel mask, attaches heatmap, makes it visible', async () => {
    const { service, renderer, segmentationImporter } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    const inf = await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    expect(inf.case_id).toBe('case_001');
    expect(segmentationImporter.calls).toHaveLength(1);
    expect(service.getState().aiSegmentation.segmentationId)
      .toBe('uncertainty:monailabel-seg:case_001');
    expect(renderer.loaded).not.toBeNull();
    expect(renderer.loaded.caseId).toBe('case_001');
    expect(service.getState().heatmap.visible).toBe(true);
    expect(service.getState().currentCase?.inference).toEqual(inf);
  });

  it('updates the cached worklist score from the selected case inference result', async () => {
    const { service, api } = buildService();
    api.worklistResponses.push([
      { case_id: 'case_001', patient_id: null, study_uid: 's', series_uid: 'ss',
        score: 0, score_band: 'low', status: 'ready' },
    ]);
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.refreshWorklist('high_first');
    api.inference.score = 0.42;

    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });

    expect(service.getState().worklist.items[0]).toMatchObject({
      case_id: 'case_001',
      score: 0.42,
      score_band: 'high',
      status: 'in_review',
    });
  });

  it('C1: openCase imports the AI mask but skips the entropy heatmap', async () => {
    const { service, renderer, segmentationImporter } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C1' });
    (service as any).api.inference.uncertainty_url = null;
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    expect(segmentationImporter.calls).toHaveLength(1);
    expect(service.getState().aiSegmentation.segmentationId).toBe('uncertainty:monailabel-seg:case_001');
    expect(renderer.loaded).toBeNull();
    expect(service.getState().heatmap.visible).toBe(false);
    expect(service.getState().currentCase?.inference?.case_id).toBe('case_001');
  });

  it('opening a new C1/C2 case unloads any previously attached heatmap first', async () => {
    const { service, renderer } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    expect(renderer.loaded?.caseId).toBe('case_001');

    service.setSession({ reviewerId: 'R01', condition: 'C1' });
    (service as any).api.inference.uncertainty_url = null;
    await service.openCase({
      caseId: 'case_002',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });

    expect(renderer.unloads).toBeGreaterThan(0);
    expect(renderer.loaded).toBeNull();
    expect(service.getState().heatmap.visible).toBe(false);
  });

  it('C0: openManualCase marks the case current without inference, AI import, or heatmap loading', async () => {
    const { service, renderer, api, segmentationImporter } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C0' });
    await service.openManualCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
    });
    expect(api.inferenceRequests).toEqual([]);
    expect(segmentationImporter.calls).toEqual([]);
    expect(renderer.loaded).toBeNull();
    expect(service.getState().currentCase).toEqual({
      caseId: 'case_001',
      inference: null,
    });
    expect(service.getState().heatmap.visible).toBe(false);
  });

  it('C0: openCase still skips AI import and heatmap loading entirely when called directly', async () => {
    const { service, renderer, segmentationImporter } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C0' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    expect(segmentationImporter.calls).toEqual([]);
    expect(renderer.loaded).toBeNull();
    expect(service.getState().heatmap.visible).toBe(false);
  });

  it('surfaces AI segmentation import failures in state', async () => {
    const { service, segmentationImporter } = buildService();
    segmentationImporter.importShouldThrow = true;
    service.setSession({ reviewerId: 'R01', condition: 'C1' });
    await expect(service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    })).rejects.toThrow(/AI segmentation import failed/);
    expect(service.getState().aiSegmentation.error).toMatch(/import failed/);
  });

  it('C2 keeps the imported AI mask editable when heatmap loading fails', async () => {
    const { service, renderer } = buildService();
    renderer.loadShouldThrow = true;
    service.setSession({ reviewerId: 'R01', condition: 'C2' });

    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });

    expect(service.getState().aiSegmentation.segmentationId)
      .toBe('uncertainty:monailabel-seg:case_001');
    expect(service.getState().aiSegmentation.error).toBeNull();
    expect(service.getState().heatmap.error).toMatch(/heatmap failed/);
    expect(service.getState().heatmap.visible).toBe(false);
  });

  it('closeCase logs case_close, removes AI mask, unloads heatmap, flushes events', async () => {
    const { service, renderer, api, segmentationImporter } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C1' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await service.closeCase();
    expect(segmentationImporter.removeCalls).toHaveLength(1);
    expect(segmentationImporter.removeCalls[0]).toMatchObject({
      segmentationId: 'uncertainty:monailabel-seg:case_001',
      viewportIds: ['vp1'],
    });
    expect(renderer.unloads).toBeGreaterThan(0);
    expect(service.getState().currentCase).toBeNull();
    // The flush after close should have shipped at least the case_open
    // and case_close events.
    const allEvents = api.postedEvents.flat();
    const types = allEvents.map(e => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['case_open', 'case_close']));
  });
});

describe('UncertaintyService — heatmap controls', () => {
  it('setHeatmapVisible(true) is refused in C0/C1', () => {
    const { service, renderer } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C1' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    service.setHeatmapVisible(true);
    expect(renderer.visible).toBeNull();
    expect(service.getState().heatmap.visible).toBe(false);
    warn.mockRestore();
  });

  it('setHeatmapVisible(false) is allowed in any condition', () => {
    const { service, renderer } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C1' });
    service.setHeatmapVisible(false);
    expect(renderer.visible).toBe(false);
  });

  it('toggleHeatmap flips and logs in C2', () => {
    const { service, renderer } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    // Need a case so the logger has a caseId; emulate via direct setter
    (service as any).bus.patch({
      currentCase: { caseId: 'case_x', inference: null },
    });
    (service as any).logger.setCurrentCase('case_x');

    service.toggleHeatmap();
    expect(renderer.visible).toBe(true);
    expect(service.getState().heatmap.visible).toBe(true);

    service.toggleHeatmap();
    expect(renderer.visible).toBe(false);
    expect(service.getState().heatmap.visible).toBe(false);
  });

  it('setHeatmapOpacity clamps to [0, 1] and updates renderer', () => {
    const { service, renderer } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    (service as any).logger.setCurrentCase('case_x');
    (service as any).bus.patch({
      currentCase: { caseId: 'case_x', inference: null },
    });

    service.setHeatmapOpacity(0.4);
    expect(renderer.opacity).toBeCloseTo(0.4);

    service.setHeatmapOpacity(2.5);
    expect(renderer.opacity).toBe(1);

    service.setHeatmapOpacity(-0.5);
    expect(renderer.opacity).toBe(0);
  });
});

describe('UncertaintyService — reviewer actions (legacy convenience wrappers)', () => {
  it('accept / reject / escalate now route through submitAnnotation', async () => {
    const { service, submissionApi } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });

    await service.acceptCurrent();
    expect(submissionApi.submissions).toHaveLength(1);
    expect(submissionApi.submissions[0].status).toBe('accepted');

    await service.rejectCurrent('looks wrong');
    expect(submissionApi.submissions).toHaveLength(2);
    expect(submissionApi.submissions[1].status).toBe('rejected');

    await service.escalateCurrent('boundary unclear');
    expect(submissionApi.submissions).toHaveLength(3);
    expect(submissionApi.submissions[2].status).toBe('escalated');
  });

  it('throws when no current case is open', async () => {
    const { service } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await expect(service.acceptCurrent())
      .rejects.toThrow(/No current case/);
  });
});

describe('UncertaintyService — subscribe', () => {
  it('subscribers are notified on state changes and unsubscribe cleanly', () => {
    const { service } = buildService();
    const observed: any[] = [];
    const unsub = service.subscribe(s => observed.push(s.session));
    service.setSession({ reviewerId: 'A', condition: 'C0' });
    service.setSession({ reviewerId: 'B', condition: 'C1' });
    unsub();
    service.setSession({ reviewerId: 'C', condition: 'C2' });
    expect(observed).toEqual([
      { reviewerId: 'A', condition: 'C0' },
      { reviewerId: 'B', condition: 'C1' },
    ]);
  });
});

// ===========================================================================
// Phase 6 — Submission flow
// ===========================================================================

describe('UncertaintyService — openCase status update (Phase 6)', () => {
  it('marks the case in_review on openCase when a session is set', async () => {
    const { service, submissionApi } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    // The status update is fire-and-forget; allow microtasks to settle.
    await new Promise(r => setTimeout(r, 0));
    expect(submissionApi.statusUpdates).toHaveLength(1);
    expect(submissionApi.statusUpdates[0]).toMatchObject({
      caseId: 'case_001', reviewerId: 'R01',
      condition: 'C2', status: 'in_review',
    });
  });

  it('does not update status if no session is set', async () => {
    const { service, submissionApi } = buildService();
    // openCase without setSession — the EventLogger will warn about
    // the case_open event having no session, which is expected behaviour.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect(submissionApi.statusUpdates).toHaveLength(0);
    warn.mockRestore();
  });

  it('survives an updateStatus failure without aborting openCase', async () => {
    const { service, submissionApi } = buildService();
    submissionApi.updateStatusShouldFail = true;
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    })).resolves.toBeDefined();
    await new Promise(r => setTimeout(r, 0));
    warn.mockRestore();
  });
});

describe('UncertaintyService — submitAnnotation', () => {
  it('happy path: calls exporter, posts to submissionApi, logs submit event', async () => {
    const { service, exporter, submissionApi, api } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });

    const out = await service.submitAnnotation({ status: 'edited' });
    expect(out.case_id).toBe('case_001');
    expect(exporter.calls).toHaveLength(1);
    expect(exporter.calls[0].referenceVolumeId).toBe('vol:image');
    expect(submissionApi.submissions).toHaveLength(1);
    expect(submissionApi.submissions[0].status).toBe('edited');

    // 'submit' event fired with the diff payload.
    await new Promise(r => setTimeout(r, 50));
    const events = api.postedEvents.flat();
    const submit = events.find(e => e.event_type === 'submit');
    expect(submit).toBeDefined();
    expect((submit!.payload as any).status).toBe('edited');
  });

  it('rejection without a mask is allowed (no exporter call)', async () => {
    const { service, exporter } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await service.submitAnnotation({
      status: 'rejected', reason: 'too noisy',
    });
    expect(exporter.calls).toHaveLength(0);
  });

  it('throws when accepted but the exporter returns null', async () => {
    const { service, exporter } = buildService();
    exporter.blobToReturn = null;
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await expect(service.submitAnnotation({ status: 'accepted' }))
      .rejects.toThrow(/exporter returned null/);
  });

  it('throws and surfaces the error in state when the export throws', async () => {
    const { service, exporter } = buildService();
    exporter.exportShouldThrow = true;
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await expect(service.submitAnnotation({ status: 'edited' }))
      .rejects.toThrow(/Segmentation export failed/);
    expect(service.getState().submission.error).toMatch(/export failed/);
    expect(service.getState().submission.isSubmitting).toBe(false);
  });

  it('throws and surfaces the error when the submit POST fails', async () => {
    const { service, submissionApi } = buildService();
    submissionApi.submitShouldFail = true;
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await expect(service.submitAnnotation({ status: 'edited' }))
      .rejects.toThrow(/submit failed/);
    expect(service.getState().submission.error).toMatch(/submit failed/);
    expect(service.getState().submission.isSubmitting).toBe(false);
  });

  it('refuses status="in_review"', async () => {
    const { service } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await expect(service.submitAnnotation({
      status: 'in_review' as SubmissionStatus,
    })).rejects.toThrow(/in_review/);
  });

  it('refuses to submit when no session is set', async () => {
    const { service } = buildService();
    // skip setSession; openCase must also be skipped because openCase
    // depends on session for status update — go straight to submit.
    await expect(service.submitAnnotation({ status: 'accepted' }))
      .rejects.toThrow(/No current case|No session/);
  });

  it('records the outcome in state.submission.lastOutcome', async () => {
    const { service } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    expect(service.getState().submission.lastOutcome).toBeNull();
    await service.submitAnnotation({ status: 'edited' });
    expect(service.getState().submission.lastOutcome).not.toBeNull();
    expect(service.getState().submission.lastOutcome?.case_id).toBe('case_001');
  });

  it('clears submission state on closeCase', async () => {
    const { service } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await service.submitAnnotation({ status: 'edited' });
    expect(service.getState().submission.lastOutcome).not.toBeNull();
    await service.closeCase();
    expect(service.getState().submission.lastOutcome).toBeNull();
  });

  it('logs the right reviewer-intent event before the network call', async () => {
    const { service, api } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    // Drain the case_open event so we can isolate the new ones.
    await (service as any).logger.flush();

    await service.submitAnnotation({ status: 'accepted' });
    await new Promise(r => setTimeout(r, 50));
    const types = api.postedEvents.flat().map(e => e.event_type);
    // We expect the intent event ('accept') to come *before* 'submit'.
    expect(types).toContain('accept');
    expect(types).toContain('submit');
    expect(types.indexOf('accept')).toBeLessThan(types.indexOf('submit'));
  });

  it('bridges viewer telemetry and emits edit_start only once per case', async () => {
    const { service, api } = buildService();
    service.setSession({ reviewerId: 'R01', condition: 'C2' });
    await service.openCase({
      caseId: 'case_001',
      referenceVolumeId: 'vol:image',
      viewportIds: ['vp1'],
    });
    await (service as any).logger.flush();
    api.postedEvents = [];

    service.logViewerEvent('slice_change', { viewportId: 'vp1' });
    service.logViewerEvent('viewport_change', { viewportId: 'vp1' });
    service.logViewerEvent('structure_focus', { segmentationId: 'seg-1' });
    service.recordSegmentationChange({ segmentationId: 'seg-1' });
    service.recordSegmentationChange({ segmentationId: 'seg-1' });
    await (service as any).logger.flush();

    const types = api.postedEvents.flat().map(e => e.event_type);
    expect(types).toEqual([
      'slice_change',
      'viewport_change',
      'structure_focus',
      'edit_start',
      'snapshot',
      'snapshot',
    ]);
  });
});
