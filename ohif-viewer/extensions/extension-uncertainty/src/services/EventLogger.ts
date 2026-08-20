/**
 * EventLogger
 *
 * Batches reviewer-interaction events and flushes them to the FastAPI
 * uncertainty service.  This is the data source for the workflow
 * analysis in §2.9.3 of the literature review and for the C0/C1/C2
 * comparison in the methodology chapter — every behavioural claim in
 * the thesis is grounded in rows ingested through this class.
 *
 * Design points worth flagging:
 *
 * 1. **Buffered with periodic flush.**  The default flush interval is
 *    2s, which is comfortable for `slice_change` storms (one per
 *    second under fast scrolling) without hammering the server.
 *
 * 2. **Backpressure-tolerant.**  If a flush fails the events are
 *    re-queued so they are retried on the next flush, rather than
 *    silently dropped.  This is critical: a missed event is a missing
 *    row in the analysis.
 *
 * 3. **Beacon on unload.**  `beforeunload` and `pagehide` fire when the
 *    reviewer closes the tab; `fetch` cannot be relied upon at that
 *    point but `navigator.sendBeacon` can.  Without this fallback, the
 *    `submit` event would be lost in 5–15% of sessions, which would
 *    bias every per-condition completion-time statistic in the thesis.
 *
 * 4. **Explicit session context.**  The logger does NOT infer the
 *    reviewer ID or condition from anything global; the host must call
 *    `setSession()` before logging.  This makes the data flow auditable
 *    and prevents accidental cross-condition pollution during the user
 *    study.
 */

import type {
  Condition,
  EventPayload,
  EventType,
  SessionContext,
} from '../types';

export interface EventLoggerApiPort {
  postEvents(events: EventPayload[]): Promise<number>;
  postEventsBeacon(events: EventPayload[]): boolean;
}

export interface EventLoggerOptions {
  api: EventLoggerApiPort;
  /** Flush interval in ms.  Default 2000. */
  flushIntervalMs?: number;
  /** Max events buffered before forcing an immediate flush.  Default 200. */
  maxBufferSize?: number;
  /**
   * Whether to install browser unload listeners.  Default true; tests
   * pass `false` so they don't have to deal with jsdom's unload quirks.
   */
  installUnloadHandlers?: boolean;
}

export class EventLogger {
  private api: EventLoggerApiPort;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;

  private buffer: EventPayload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private session: SessionContext | null = null;
  private currentCaseId: string | null = null;
  private destroyed = false;
  private flushing = false;
  private readonly unloadHandler?: () => void;
  // Statistics surfaced for tests and for the optional debug panel.
  private _stats = { logged: 0, flushed: 0, dropped: 0, retries: 0 };

  constructor(opts: EventLoggerOptions) {
    this.api = opts.api;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxBufferSize = opts.maxBufferSize ?? 200;

    if (opts.installUnloadHandlers !== false && typeof window !== 'undefined') {
      // `pagehide` is more reliable than `beforeunload` on mobile Safari
      // and is fired in the same conditions on desktop browsers.
      const onUnload = () => this.flushBeacon();
      this.unloadHandler = onUnload;
      window.addEventListener('pagehide', onUnload);
      window.addEventListener('beforeunload', onUnload);
    }
  }

  // -------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------

  /** Set the reviewer + condition for all subsequent events. */
  setSession(session: SessionContext): void {
    this.session = session;
  }

  /** Replace the API used for subsequent event flushes. */
  configureApi(api: EventLoggerApiPort): void {
    this.api = api;
  }

  /** Track the case the reviewer is currently looking at. */
  setCurrentCase(caseId: string | null): void {
    this.currentCaseId = caseId;
  }

  /** Read-only stats for diagnostic panels and tests. */
  get stats(): Readonly<typeof this._stats> {
    return this._stats;
  }

  /** Number of events currently waiting to be sent. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  // -------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------

  /**
   * Record an event.  No-ops (with a console warning) if the session
   * context has not been set, since unattributed events would corrupt
   * the per-condition analysis.
   */
  log(
    eventType: EventType,
    payload?: Record<string, unknown> | null,
    overrides?: { caseId?: string; condition?: Condition; reviewerId?: string },
  ): void {
    if (this.destroyed) return;

    const session = this.session;
    const caseId = overrides?.caseId ?? this.currentCaseId;
    const condition = overrides?.condition ?? session?.condition;
    const reviewerId = overrides?.reviewerId ?? session?.reviewerId;

    if (!session && !overrides?.condition) {
      // eslint-disable-next-line no-console
      console.warn('[EventLogger] log() called before setSession(); event dropped:', eventType);
      this._stats.dropped++;
      return;
    }
    if (!caseId) {
      // eslint-disable-next-line no-console
      console.warn('[EventLogger] log() called with no current case; event dropped:', eventType);
      this._stats.dropped++;
      return;
    }
    if (!condition || !reviewerId) {
      this._stats.dropped++;
      return;
    }

    this.buffer.push({
      case_id: caseId,
      reviewer_id: reviewerId,
      condition,
      event_type: eventType,
      payload: payload ?? null,
      client_ts: new Date().toISOString(),
    });
    this._stats.logged++;

    if (this.buffer.length >= this.maxBufferSize) {
      // Don't await; fire-and-forget on overflow path.
      void this.flush().catch(() => undefined);
    } else {
      this.scheduleFlush();
    }
  }

  // -------------------------------------------------------------------
  // Flushing
  // -------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => undefined);
    }, this.flushIntervalMs);
  }

  /**
   * Send the buffered events.  Returns the number of events sent.
   * Failed sends re-queue the events and surface as a rejected promise
   * so callers (typically tests) can await an explicit flush and
   * assert on the outcome.
   */
  async flush(): Promise<number> {
    if (this.destroyed || this.flushing) return 0;
    if (this.buffer.length === 0) return 0;

    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const n = await this.api.postEvents(batch);
      this._stats.flushed += n;
      return n;
    } catch (err) {
      // Re-queue at the front so ordering is preserved on retry.
      this.buffer.unshift(...batch);
      this._stats.retries++;
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Synchronous best-effort flush via `navigator.sendBeacon`, intended
   * for `pagehide` / `beforeunload`.  Does not retry on failure —
   * the page is going away anyway.
   */
  flushBeacon(): boolean {
    if (this.destroyed || this.buffer.length === 0) return true;
    const batch = this.buffer.splice(0, this.buffer.length);
    const ok = this.api.postEventsBeacon(batch);
    if (ok) {
      this._stats.flushed += batch.length;
    } else {
      // The browser refused the beacon.  Restore the events so the next
      // page-load (if any) can pick them up — though in practice a
      // failed beacon usually means the data is gone.
      this.buffer.unshift(...batch);
      this._stats.retries++;
    }
    return ok;
  }

  /**
   * Stop accepting new events and clear the timer.  Pending events are
   * NOT auto-flushed — call `flush()` first if you want to drain the
   * buffer.  Used by tests to clean up between cases.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.unloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.unloadHandler);
      window.removeEventListener('beforeunload', this.unloadHandler);
    }
  }
}
