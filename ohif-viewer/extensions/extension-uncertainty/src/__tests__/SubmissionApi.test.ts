import { SubmissionApi, SubmissionApiError } from '../services/SubmissionApi';

function fakeResponse(opts: {
  status: number;
  body?: string;
  json?: unknown;
}): Response {
  const status = opts.status;
  const body = opts.body
    ?? (opts.json !== undefined ? JSON.stringify(opts.json) : '');
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => body,
    json: async () => (opts.json !== undefined ? opts.json : JSON.parse(body)),
    headers: new Map() as unknown as Headers,
  } as unknown as Response;
}

describe('SubmissionApi', () => {
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

  const api = new SubmissionApi({
    baseUrl: 'http://test',
    fetchImpl,
    timeoutMs: 1000,
  });

  beforeEach(() => {
    calls = [];
    nextResponses = [];
  });

  // -------------------------------------------------------------------
  // submit
  // -------------------------------------------------------------------

  it('POST /annotations posts multipart with case/reviewer/condition/status fields', async () => {
    nextResponses.push(fakeResponse({ status: 201, json: {
      case_id: 'c', reviewer_id: 'R01', condition: 'C2',
      storage_url: '/s', edit_voxel_count: 3, ai_foreground_voxels: 100,
      reviewer_foreground_voxels: 102,
      edit_fraction_of_ai_foreground: 0.03,
      submitted_at: '2026-04-28T12:00:00Z',
    } }));
    const blob = new Blob(['data'], { type: 'application/octet-stream' });
    const out = await api.submit({
      caseId: 'c',
      reviewerId: 'R01',
      condition: 'C2',
      status: 'edited',
      maskBlob: blob,
    });
    expect(out.edit_voxel_count).toBe(3);
    expect(calls[0].url).toBe('http://test/annotations');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBeInstanceOf(FormData);
    const fd = calls[0].init?.body as FormData;
    expect(fd.get('case_id')).toBe('c');
    expect(fd.get('reviewer_id')).toBe('R01');
    expect(fd.get('condition')).toBe('C2');
    expect(fd.get('status')).toBe('edited');
    // FormData stores File for blobs in node; the value is non-null
    // even though we can't inspect File internals without polyfills.
    expect(fd.get('mask')).not.toBeNull();
  });

  it('throws if a non-rejected status has no maskBlob', async () => {
    await expect(api.submit({
      caseId: 'c', reviewerId: 'R01',
      condition: 'C2', status: 'edited',
      // no maskBlob
    })).rejects.toThrow(/requires a maskBlob/);
  });

  it('allows rejected status without a maskBlob', async () => {
    nextResponses.push(fakeResponse({ status: 201, json: {
      case_id: 'c', reviewer_id: 'R01', condition: 'C2',
      storage_url: '', edit_voxel_count: 0, ai_foreground_voxels: 0,
      reviewer_foreground_voxels: 0, edit_fraction_of_ai_foreground: 0,
      submitted_at: '2026-04-28T12:00:00Z',
    } }));
    const out = await api.submit({
      caseId: 'c', reviewerId: 'R01',
      condition: 'C2', status: 'rejected',
    });
    expect(out.edit_voxel_count).toBe(0);
    const fd = calls[0].init?.body as FormData;
    expect(fd.get('status')).toBe('rejected');
    expect(fd.get('mask')).toBeNull();
  });

  // -------------------------------------------------------------------
  // updateStatus
  // -------------------------------------------------------------------

  it('PUT /annotations/status/{case}/{reviewer} sends JSON', async () => {
    nextResponses.push(fakeResponse({ status: 200, json: {
      case_id: 'c', reviewer_id: 'R01', condition: 'C2',
      status: 'in_review', started_at: 'T', ended_at: null,
    } }));
    const out = await api.updateStatus({
      caseId: 'c', reviewerId: 'R01',
      condition: 'C2', status: 'in_review',
    });
    expect(out.status).toBe('in_review');
    expect(calls[0].url).toBe('http://test/annotations/status/c/R01');
    expect(calls[0].init?.method).toBe('PUT');
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.status).toBe('in_review');
  });

  it('URL-encodes case ids that contain dots and slashes', async () => {
    nextResponses.push(fakeResponse({ status: 200, json: {
      case_id: '1.2/3', reviewer_id: 'R01', condition: 'C2',
      status: 'in_review', started_at: null, ended_at: null,
    } }));
    await api.updateStatus({
      caseId: '1.2/3', reviewerId: 'R01',
      condition: 'C2', status: 'in_review',
    });
    expect(calls[0].url).toBe('http://test/annotations/status/1.2%2F3/R01');
  });

  // -------------------------------------------------------------------
  // getAnnotation
  // -------------------------------------------------------------------

  it('GET returns the outcome on 200', async () => {
    nextResponses.push(fakeResponse({ status: 200, json: {
      case_id: 'c', reviewer_id: 'R01', condition: 'C2',
      storage_url: '/s', edit_voxel_count: 1, ai_foreground_voxels: 10,
      reviewer_foreground_voxels: 11, edit_fraction_of_ai_foreground: 0.1,
      submitted_at: 'T',
    } }));
    const out = await api.getAnnotation({ caseId: 'c', reviewerId: 'R01' });
    expect(out?.edit_voxel_count).toBe(1);
  });

  it('GET returns null on 404 instead of throwing', async () => {
    nextResponses.push(fakeResponse({ status: 404, body: 'not found' }));
    const out = await api.getAnnotation({ caseId: 'c', reviewerId: 'R01' });
    expect(out).toBeNull();
  });

  it('GET throws on 500 (not 404)', async () => {
    nextResponses.push(fakeResponse({ status: 500, body: 'boom' }));
    await expect(api.getAnnotation({ caseId: 'c', reviewerId: 'R01' }))
      .rejects.toBeInstanceOf(SubmissionApiError);
  });

  // -------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------

  it('translates network errors into SubmissionApiError', async () => {
    nextResponses.push(new Error('ECONNREFUSED'));
    await expect(api.submit({
      caseId: 'c', reviewerId: 'R01',
      condition: 'C2', status: 'rejected',
    })).rejects.toMatchObject({ name: 'SubmissionApiError' });
  });

  it('surfaces the response status on errors', async () => {
    nextResponses.push(fakeResponse({ status: 422, body: 'shape mismatch' }));
    try {
      await api.submit({
        caseId: 'c', reviewerId: 'R01',
        condition: 'C2', status: 'edited',
        maskBlob: new Blob(['x']),
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubmissionApiError);
      expect((err as SubmissionApiError).status).toBe(422);
      expect((err as SubmissionApiError).body).toContain('shape mismatch');
    }
  });
});
