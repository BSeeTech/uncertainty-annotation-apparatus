/**
 * Phase 6 additions to the FastAPI client.
 *
 * Wraps the three new endpoints introduced by `uncertainty_service`'s
 * annotations router:
 *
 *   POST /annotations          (multipart upload)
 *   PUT  /annotations/status/{case_id}/{reviewer_id}
 *   GET  /annotations/{case_id}/{reviewer_id}
 *
 * We export it as a separate file so the Phase-4 `WorklistApi` stays
 * focused on inference, worklist, and events; submissions are a
 * meaningfully different lifecycle and warrant their own surface.
 *
 * Both classes share the same `WorklistApiOptions` shape so the host
 * app constructs them with the same `baseUrl` and (optionally) the
 * same `fetchImpl`.
 */

import type { Condition } from '../types';

export type SubmissionStatus =
  | 'in_review'
  | 'accepted'
  | 'edited'
  | 'rejected'
  | 'escalated';

export interface SubmissionOutcome {
  case_id: string;
  reviewer_id: string;
  condition: Condition;
  storage_url: string | null;
  edit_voxel_count: number;
  ai_foreground_voxels: number;
  reviewer_foreground_voxels: number;
  edit_fraction_of_ai_foreground: number;
  submitted_at: string;
}

export interface AnnotationStatusOutcome {
  case_id: string;
  reviewer_id: string;
  condition: Condition;
  status: SubmissionStatus;
  started_at: string | null;
  ended_at: string | null;
}

export interface SubmissionApiOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SubmissionApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'SubmissionApiError';
  }
}

export class SubmissionApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SubmissionApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;   // mask uploads can be large
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // -------------------------------------------------------------------
  // POST /annotations
  // -------------------------------------------------------------------

  /**
   * Submit a reviewer's annotation.  ``maskBlob`` is required for
   * statuses other than ``rejected``.  For ``rejected``, the server
   * accepts an empty submission and records the rejection in
   * `AnnotationStatus`; this exists to give the analysis chapter a
   * count of "no useful annotation possible" decisions per condition.
   */
  async submit(args: {
    caseId: string;
    reviewerId: string;
    condition: Condition;
    status: SubmissionStatus;
    maskBlob?: Blob;
    /** Filename hint for the upload — defaults to `{caseId}.nii.gz`. */
    maskFilename?: string;
    signal?: AbortSignal;
  }): Promise<SubmissionOutcome> {
    if (args.status !== 'rejected' && !args.maskBlob) {
      throw new SubmissionApiError(
        `status='${args.status}' requires a maskBlob; only 'rejected' may omit it.`,
      );
    }

    const form = new FormData();
    form.append('case_id', args.caseId);
    form.append('reviewer_id', args.reviewerId);
    form.append('condition', args.condition);
    form.append('status', args.status);
    if (args.maskBlob) {
      form.append(
        'mask',
        args.maskBlob,
        args.maskFilename ?? `${args.caseId}.nii.gz`,
      );
    }

    return this.send<SubmissionOutcome>('/annotations', {
      method: 'POST',
      body: form,
      signal: args.signal,
    });
  }

  // -------------------------------------------------------------------
  // PUT /annotations/status/{case}/{reviewer}
  // -------------------------------------------------------------------

  /**
   * Update only the status row.  Used by the OHIF mode to mark a case
   * `in_review` when the reviewer opens it, before any submission.
   *
   * Returns the canonical row as the server stores it (including
   * server-assigned timestamps).
   */
  async updateStatus(args: {
    caseId: string;
    reviewerId: string;
    condition: Condition;
    status: SubmissionStatus;
    signal?: AbortSignal;
  }): Promise<AnnotationStatusOutcome> {
    const path = `/annotations/status/${encodeURIComponent(args.caseId)}/${encodeURIComponent(args.reviewerId)}`;
    return this.send<AnnotationStatusOutcome>(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        case_id: args.caseId,
        reviewer_id: args.reviewerId,
        condition: args.condition,
        status: args.status,
      }),
      signal: args.signal,
    });
  }

  // -------------------------------------------------------------------
  // GET /annotations/{case}/{reviewer}
  // -------------------------------------------------------------------

  async getAnnotation(args: {
    caseId: string;
    reviewerId: string;
    condition: Condition;
    signal?: AbortSignal;
  }): Promise<SubmissionOutcome | null> {
    const path = `/annotations/${encodeURIComponent(args.caseId)}/${encodeURIComponent(args.reviewerId)}`
      + `?condition=${encodeURIComponent(args.condition)}`;
    try {
      return await this.send<SubmissionOutcome>(path, {
        method: 'GET',
        signal: args.signal,
      });
    } catch (err) {
      // 404 is a normal "not yet submitted" state — return null
      // rather than throwing so the OHIF panel can branch cleanly.
      if (err instanceof SubmissionApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async send<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const externalSignal = init.signal;
    const handle = setTimeout(
      () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
      init.timeoutMs ?? this.timeoutMs,
    );
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort',
        () => controller.abort(externalSignal.reason),
        { once: true });
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw new SubmissionApiError(
        `Network error calling ${path}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(handle);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new SubmissionApiError(
        `${path} → ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`,
        resp.status,
        text,
      );
    }
    if (resp.status === 204) return undefined as unknown as T;
    return resp.json() as Promise<T>;
  }
}
