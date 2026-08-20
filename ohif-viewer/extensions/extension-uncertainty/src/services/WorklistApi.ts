/**
 * Typed client for the Phase-2 FastAPI uncertainty service.
 *
 * One class, one base URL, one set of `fetch` calls.  The FastAPI
 * endpoints it talks to are:
 *
 *   POST /infer/{case_id}              → InferenceResult
 *   GET  /worklist?policy=...          → WorklistEntry[]
 *   POST /events                       → { ingested: number }
 *   GET  /cases/{id}                   → CaseOut
 *
 * Network failures and non-2xx responses are translated into a
 * `WorklistApiError` with a stable `kind` discriminator so the React
 * panels can render meaningful messages without parsing strings.
 */

import type {
  Condition,
  EventPayload,
  InferenceResult,
  WorklistEntry,
  WorklistPolicy,
} from '../types';

export type WorklistApiErrorKind =
  | 'network'         // fetch threw (offline, CORS, etc.)
  | 'not_found'       // 404
  | 'upstream'        // 502 — MONAI Label failed
  | 'validation'      // 422 — bad payload
  | 'conflict'        // 409 — duplicate case / FK rejection
  | 'server'          // 5xx other
  | 'unknown';

export class WorklistApiError extends Error {
  constructor(
    message: string,
    public readonly kind: WorklistApiErrorKind,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'WorklistApiError';
  }
}

function classifyStatus(status: number): WorklistApiErrorKind {
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  if (status === 502) return 'upstream';
  if (status >= 500) return 'server';
  return 'unknown';
}

function rewriteDockerOnlyMonaiUrl(
  value: string | null,
  uncertaintyServiceBaseUrl: string,
): string | null {
  if (!value) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  if (!['monai-label', 'medical-monai', 'orthanc'].includes(url.hostname)) {
    return value;
  }

  const base = new URL(uncertaintyServiceBaseUrl);
  base.pathname = `/monai${url.pathname}`;
  base.search = url.search;
  base.hash = '';
  return base.toString();
}

function normalizeInferenceUrls(
  result: InferenceResult,
  uncertaintyServiceBaseUrl: string,
): InferenceResult {
  return {
    ...result,
    segmentation_url: rewriteDockerOnlyMonaiUrl(
      result.segmentation_url,
      uncertaintyServiceBaseUrl,
    ) ?? result.segmentation_url,
    uncertainty_url: rewriteDockerOnlyMonaiUrl(
      result.uncertainty_url,
      uncertaintyServiceBaseUrl,
    ),
  };
}

export interface WorklistApiOptions {
  /** Base URL of the FastAPI uncertainty service. */
  baseUrl: string;
  /** Per-request timeout in ms.  Default 60s. */
  timeoutMs?: number;
  /**
   * Optional `fetch` override.  Mainly here so tests can pass a
   * stub implementation without touching `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
}

/** Browser inference is a cache lookup; model execution is administrative. */
export const INFERENCE_TIMEOUT_MS = 60_000;

export class WorklistApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WorklistApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  async getWorklist(opts: {
    policy: WorklistPolicy;
    limit?: number;
    reviewerId?: string;
    includeCompleted?: boolean;
    signal?: AbortSignal;
  }): Promise<WorklistEntry[]> {
    const qs = new URLSearchParams({
      policy: opts.policy,
      limit: String(opts.limit ?? 50),
    });
    if (opts.reviewerId) qs.set('reviewer_id', opts.reviewerId);
    if (opts.includeCompleted) qs.set('include_completed', 'true');
    return this.request<WorklistEntry[]>(`/worklist?${qs.toString()}`, {
      method: 'GET',
      signal: opts.signal,
    });
  }

  async runInference(
    caseId: string,
    conditionOrSignal?: Condition | AbortSignal | null,
    signal?: AbortSignal,
  ): Promise<InferenceResult> {
    const condition =
      typeof conditionOrSignal === 'string' ? conditionOrSignal : undefined;
    const effectiveSignal =
      typeof conditionOrSignal === 'string'
        ? signal
        : conditionOrSignal ?? signal;
    const body = condition ? JSON.stringify({ condition }) : undefined;

    const result = await this.request<InferenceResult>(`/infer/${encodeURIComponent(caseId)}`, {
      method: 'POST',
      signal: effectiveSignal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
      // The public route is cache-only and must return promptly.
      timeoutMs: INFERENCE_TIMEOUT_MS,
    });
    return normalizeInferenceUrls(result, this.baseUrl);
  }

  /**
   * Posts a batch of reviewer events.  Returns the count the server
   * acknowledged (which is also `events.length` on success).
   */
  async postEvents(events: EventPayload[]): Promise<number> {
    if (events.length === 0) return 0;
    const body = JSON.stringify({ events });
    const result = await this.request<{ ingested: number }>('/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return result.ingested;
  }

  /**
   * "Best-effort" event post for use during page unload.  Falls back to
   * `navigator.sendBeacon` when available, since `fetch` cannot be
   * relied upon to complete during a `beforeunload` handler.  Returns
   * `true` if the browser accepted the beacon for transmission.
   */
  postEventsBeacon(events: EventPayload[]): boolean {
    if (events.length === 0) return true;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return false;
    }
    const blob = new Blob([JSON.stringify({ events })], {
      type: 'application/json',
    });
    return navigator.sendBeacon(`${this.baseUrl}/events`, blob);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const externalSignal = init.signal;
    const timeoutHandle = setTimeout(
      () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
      init.timeoutMs ?? this.timeoutMs,
    );

    // Forward an external abort to our local controller so consumers
    // can cancel both ways without losing the timeout protection.
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
      throw new WorklistApiError(
        `Network error calling ${path}: ${(err as Error).message}`,
        'network',
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new WorklistApiError(
        `${path} → ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`,
        classifyStatus(resp.status),
        resp.status,
        text,
      );
    }

    // No-content responses return undefined; callers should not request
    // them via `request<T>` unless `T` is `void`.
    if (resp.status === 204) return undefined as unknown as T;

    const contentType = resp.headers.get('Content-Type') ?? '';
    if (contentType && !contentType.includes('application/json')) {
      const text = await resp.text().catch(() => '');
      throw new WorklistApiError(
        `Server returned non-JSON response (Content-Type: ${contentType}). ` +
        `The backend may be unreachable — received HTML instead of JSON. ` +
        `Body starts with: "${text.slice(0, 100)}"`,
        'unknown',
        resp.status,
        text,
      );
    }

    const respClone = resp.clone();
    try {
      return await resp.json() as T;
    } catch (err) {
      const text = await respClone.text().catch(() => '');
      throw new WorklistApiError(
        `Failed to parse JSON response from ${path}: ${(err as Error).message}. ` +
        `Body starts with: "${text.slice(0, 100)}"`,
        'unknown',
        resp.status,
        text,
      );
    }
  }
}
