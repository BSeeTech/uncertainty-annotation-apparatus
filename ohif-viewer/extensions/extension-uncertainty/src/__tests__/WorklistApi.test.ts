import {
  INFERENCE_TIMEOUT_MS,
  WorklistApi,
  WorklistApiError,
} from '../services/WorklistApi';
import type { EventPayload } from '../types';

/**
 * Build a minimal Response-shaped object that satisfies the bits of the
 * Fetch API the WorklistApi actually uses (`ok`, `status`, `statusText`,
 * `.text()`, `.json()`).  We do this rather than `new Response(...)` so
 * the tests don't depend on a fetch polyfill in jsdom.
 */
function fakeResponse(opts: {
  status: number;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status;
  const body = opts.body
    ?? (opts.json !== undefined ? JSON.stringify(opts.json) : '');
  const headers = opts.headers ?? {};
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText(status),
    text: async () => body,
    json: async () => (opts.json !== undefined ? opts.json : JSON.parse(body)),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    } as unknown as Headers,
    clone() { return this; },
  } as unknown as Response;
  return response;
}

function jsonResponse(body: unknown, status = 200): Response {
  return fakeResponse({
    status,
    json: body,
    headers: { 'content-type': 'application/json' },
  });
}
function textResponse(body: string, status: number, contentType = 'text/plain'): Response {
  return fakeResponse({ status, body, headers: { 'content-type': contentType } });
}
function htmlResponse(body: string, status = 200): Response {
  return fakeResponse({ status, body, headers: { 'content-type': 'text/html' } });
}
function statusText(s: number): string {
  switch (s) {
    case 200: return 'OK';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 422: return 'Unprocessable Entity';
    case 502: return 'Bad Gateway';
    case 500: return 'Internal Server Error';
    default:  return '';
  }
}

describe('WorklistApi', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;
  let nextResponses: Array<Response | Error>;

  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, init: init ?? undefined });
    const next = nextResponses.shift();
    if (!next) return Promise.reject(new Error('no response queued'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };

  const api = new WorklistApi({
    baseUrl: 'http://test',
    fetchImpl,
    timeoutMs: 1000,
  });

  beforeEach(() => {
    calls = [];
    nextResponses = [];
  });

  // -----------------------------------------------------------------
  // getWorklist
  // -----------------------------------------------------------------

  it('GET /worklist passes policy and limit, parses JSON', async () => {
    nextResponses.push(jsonResponse([
      { case_id: 'a', patient_id: null, study_uid: 's', series_uid: 'ss',
        score: 0.4, score_band: 'high', status: 'pending' },
    ]));
    const items = await api.getWorklist({ policy: 'high_first', limit: 25 });
    expect(items).toHaveLength(1);
    expect(items[0].case_id).toBe('a');
    expect(calls[0].url).toBe('http://test/worklist?policy=high_first&limit=25');
    expect(calls[0].init?.method).toBe('GET');
  });

  it('GET /worklist forwards reviewerId and includeCompleted', async () => {
    nextResponses.push(jsonResponse([]));
    await api.getWorklist({
      policy: 'fifo',
      limit: 10,
      reviewerId: 'R03',
      includeCompleted: true,
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('policy')).toBe('fifo');
    expect(url.searchParams.get('reviewer_id')).toBe('R03');
    expect(url.searchParams.get('include_completed')).toBe('true');
  });

  // -----------------------------------------------------------------
  // runInference
  // -----------------------------------------------------------------

  it('POST /infer/{id} returns the inference payload', async () => {
    nextResponses.push(jsonResponse({
      case_id: 'case_001',
      segmentation_url: '/files/cases/case_001/case_001.nii.gz',
      uncertainty_url:  '/files/cases/case_001/case_001_entropy.nii.gz',
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
      metrics_version: 'ct-spleen-v1',
      artifact_generation: 'generation-001',
      result_url: '/results/case_001?condition=C2',
      cache_hit: true,
    }));
    const r = await api.runInference('case_001');
    expect(r.score).toBeCloseTo(0.42);
    expect(r.checkpoint_version).toContain('radiology_segmentation_unet_spleen');
    expect(r.num_samples).toBe(16);
    expect(r.cache_hit).toBe(true);
    expect(calls[0].url).toBe('http://test/infer/case_001');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('rewrites Docker-only MONAI Label file URLs through the uncertainty proxy', async () => {
    const proxiedApi = new WorklistApi({
      baseUrl: 'http://localhost:58050',
      fetchImpl,
      timeoutMs: 1000,
    });
    nextResponses.push(jsonResponse({
      case_id: 'case_001',
      segmentation_url: 'http://monai-label:8000/datastore/label/case_001?task=mcdropout_seg',
      uncertainty_url:  'http://monai-label:8000/datastore/label/case_001_entropy?task=mcdropout_seg',
      model_version: 'mcdropout_seg_v1',
      num_samples: 16,
      score: 0.42,
      score_p95: 0.61,
      score_fraction_above: 0.20,
      score_mean_all: 0.10,
      threshold: 0.5,
    }));

    const r = await proxiedApi.runInference('case_001', 'C2');

    expect(r.segmentation_url).toBe(
      'http://localhost:58050/monai/datastore/label/case_001?task=mcdropout_seg',
    );
    expect(r.uncertainty_url).toBe(
      'http://localhost:58050/monai/datastore/label/case_001_entropy?task=mcdropout_seg',
    );
  });

  it('URL-encodes case ids that contain dots and slashes', async () => {
    nextResponses.push(jsonResponse({
      case_id: '1.2/3',
      segmentation_url: '', uncertainty_url: '',
      model_version: 'v', num_samples: 16,
      score: 0, score_p95: 0, score_fraction_above: 0, score_mean_all: 0,
      threshold: 0.5,
    }));
    await api.runInference('1.2/3');
    expect(calls[0].url).toBe('http://test/infer/1.2%2F3');
  });

  it('uses a 60-second cache lookup timeout instead of a model-runtime timeout', async () => {
    jest.useFakeTimers();
    const slowFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, init: init ?? undefined });
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
    };
    const slowApi = new WorklistApi({
      baseUrl: 'http://test',
      fetchImpl: slowFetch,
      timeoutMs: 1000,
    });

    const resultPromise = slowApi.runInference('case_slow', 'C2');
    jest.advanceTimersByTime(INFERENCE_TIMEOUT_MS);

    await expect(resultPromise).rejects.toMatchObject({ kind: 'network' });
    expect(INFERENCE_TIMEOUT_MS).toBe(60_000);
    jest.useRealTimers();
  });

  // -----------------------------------------------------------------
  // postEvents
  // -----------------------------------------------------------------

  it('POST /events sends the batch JSON and returns the count', async () => {
    nextResponses.push(jsonResponse({ ingested: 2 }));
    const events: EventPayload[] = [
      { case_id: 'c', reviewer_id: 'R01', condition: 'C2', event_type: 'case_open' },
      { case_id: 'c', reviewer_id: 'R01', condition: 'C2', event_type: 'submit' },
    ];
    const n = await api.postEvents(events);
    expect(n).toBe(2);
    const sent = JSON.parse((calls[0].init!.body as string));
    expect(sent.events).toHaveLength(2);
    expect(sent.events[0].event_type).toBe('case_open');
  });

  it('POST /events with empty batch is a no-op', async () => {
    const n = await api.postEvents([]);
    expect(n).toBe(0);
    expect(calls).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // postEventsBeacon
  // -----------------------------------------------------------------

  it('postEventsBeacon dispatches via navigator.sendBeacon and returns its result', () => {
    const beacon = jest.fn().mockReturnValue(true);
    // jsdom's `navigator` is read-only on globalThis, but its properties
    // can be redefined.  Use Object.defineProperty so this works
    // regardless of whether jsdom already provides a sendBeacon.
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: beacon,
    });
    const events: EventPayload[] = [
      { case_id: 'c', reviewer_id: 'R01', condition: 'C2', event_type: 'case_close' },
    ];
    const ok = api.postEventsBeacon(events);
    expect(ok).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe('http://test/events');
  });

  it('postEventsBeacon returns false when sendBeacon is unavailable', () => {
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const ok = api.postEventsBeacon([
      { case_id: 'c', reviewer_id: 'R01', condition: 'C2', event_type: 'case_close' },
    ]);
    expect(ok).toBe(false);
  });

  // -----------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------

  it('classifies 404 as not_found', async () => {
    nextResponses.push(textResponse('Case missing', 404));
    await expect(api.runInference('nope')).rejects.toMatchObject({
      kind: 'not_found',
      status: 404,
    });
  });

  it('classifies 502 as upstream', async () => {
    nextResponses.push(textResponse('MONAI failed', 502));
    await expect(api.runInference('x')).rejects.toMatchObject({
      kind: 'upstream',
      status: 502,
    });
  });

  it('classifies 422 as validation', async () => {
    nextResponses.push(textResponse('bad payload', 422));
    await expect(api.runInference('x')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('classifies 409 as conflict', async () => {
    nextResponses.push(textResponse('dup', 409));
    await expect(api.runInference('x')).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('classifies 500 as server', async () => {
    nextResponses.push(textResponse('boom', 500));
    await expect(api.runInference('x')).rejects.toMatchObject({
      kind: 'server',
    });
  });

  it('translates fetch-thrown errors into network', async () => {
    nextResponses.push(new Error('ECONNREFUSED'));
    await expect(
      api.getWorklist({ policy: 'high_first' }),
    ).rejects.toBeInstanceOf(WorklistApiError);
    await expect(
      api.getWorklist({ policy: 'high_first' }),
    ).rejects.toMatchObject({ kind: 'network' });
    // Note: each .rejects.* drains one response; we queued two.
    nextResponses.unshift(new Error('ECONNREFUSED'));
  });

  // -----------------------------------------------------------------
  // Non-JSON / malformed response guarding (Content-Type check + parse catch)
  // -----------------------------------------------------------------

  it('rejects with clear message when server returns HTML (200 but Content-Type: text/html)', async () => {
    nextResponses.push(htmlResponse('<!doctype html><html>nginx error</html>'));
    const err = await api.getWorklist({ policy: 'fifo' }).catch(e => e);
    expect(err).toBeInstanceOf(WorklistApiError);
    expect(err.kind).toBe('unknown');
    expect(err.message).toContain('non-JSON response');
    expect(err.message).toContain('nginx error');
  });

  it('rejects with clear message when Content-Type is missing and body is not valid JSON', async () => {
    // JSON parse fails, but no Content-Type to trigger the early guard
    nextResponses.push(fakeResponse({ status: 200, body: '<html>', headers: {} }));
    await expect(api.getWorklist({ policy: 'fifo' })).rejects.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('Failed to parse JSON'),
    });
  });

  it('accepts valid JSON when Content-Type includes application/json', async () => {
    nextResponses.push(jsonResponse([
      { case_id: 'b', patient_id: null, study_uid: 's2', series_uid: 'ss2',
        score: 0.5, score_band: 'medium', status: 'pending' },
    ]));
    const items = await api.getWorklist({ policy: 'fifo', limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].case_id).toBe('b');
  });

  it('rejects when response body claims application/json but contains invalid syntax', async () => {
    nextResponses.push(fakeResponse({
      status: 200,
      body: '{ broken ]',
      headers: { 'content-type': 'application/json' },
    }));
    await expect(api.getWorklist({ policy: 'fifo' })).rejects.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('Failed to parse JSON'),
    });
  });
});
