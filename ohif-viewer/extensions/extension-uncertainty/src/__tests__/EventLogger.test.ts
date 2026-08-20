import { EventLogger } from '../services/EventLogger';
import type { EventPayload } from '../types';

class StubApi {
  posted: EventPayload[][] = [];
  beaconed: EventPayload[][] = [];
  postShouldFail = false;
  beaconShouldFail = false;

  async postEvents(events: EventPayload[]): Promise<number> {
    if (this.postShouldFail) throw new Error('post failed');
    this.posted.push([...events]);
    return events.length;
  }
  postEventsBeacon(events: EventPayload[]): boolean {
    if (this.beaconShouldFail) return false;
    this.beaconed.push([...events]);
    return true;
  }
}

const session = { reviewerId: 'R01', condition: 'C2' as const };

describe('EventLogger', () => {
  let api: StubApi;
  let logger: EventLogger;

  beforeEach(() => {
    api = new StubApi();
    logger = new EventLogger({
      api: api as any,
      flushIntervalMs: 50,
      installUnloadHandlers: false,
    });
    logger.setSession(session);
    logger.setCurrentCase('case_x');
  });

  afterEach(() => {
    logger.destroy();
  });

  it('buffers events and flushes on demand', async () => {
    logger.log('case_open');
    logger.log('slice_change', { slice: 12 });
    expect(logger.pendingCount).toBe(2);
    expect(api.posted).toHaveLength(0);
    const n = await logger.flush();
    expect(n).toBe(2);
    expect(api.posted).toHaveLength(1);
    expect(api.posted[0].map(e => e.event_type)).toEqual(['case_open', 'slice_change']);
  });

  it('drops events when no session is set', () => {
    const l = new EventLogger({
      api: api as any, installUnloadHandlers: false, flushIntervalMs: 50,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    l.log('case_open');
    expect(l.pendingCount).toBe(0);
    expect(l.stats.dropped).toBe(1);
    warn.mockRestore();
    l.destroy();
  });

  it('drops events when no current case is set', () => {
    const l = new EventLogger({
      api: api as any, installUnloadHandlers: false, flushIntervalMs: 50,
    });
    l.setSession(session);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    l.log('heatmap_toggle', { visible: true });
    expect(l.pendingCount).toBe(0);
    expect(l.stats.dropped).toBe(1);
    warn.mockRestore();
    l.destroy();
  });

  it('attaches session + caseId + ISO timestamp to every event', () => {
    logger.log('case_open');
    const ev = (logger as any).buffer[0] as EventPayload;
    expect(ev.case_id).toBe('case_x');
    expect(ev.reviewer_id).toBe('R01');
    expect(ev.condition).toBe('C2');
    expect(ev.event_type).toBe('case_open');
    expect(typeof ev.client_ts).toBe('string');
    // ISO 8601 with timezone
    expect(ev.client_ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('overrides take precedence over session/current case', () => {
    logger.log('escalate', { reason: 'x' }, {
      caseId: 'other_case',
      condition: 'C1',
      reviewerId: 'R99',
    });
    const ev = (logger as any).buffer[0] as EventPayload;
    expect(ev.case_id).toBe('other_case');
    expect(ev.condition).toBe('C1');
    expect(ev.reviewer_id).toBe('R99');
  });

  it('re-queues events on flush failure and retries on next flush', async () => {
    api.postShouldFail = true;
    logger.log('submit');
    await expect(logger.flush()).rejects.toThrow();
    expect(logger.pendingCount).toBe(1);   // re-queued
    expect(logger.stats.retries).toBe(1);

    api.postShouldFail = false;
    const n = await logger.flush();
    expect(n).toBe(1);
    expect(api.posted).toHaveLength(1);
    expect(api.posted[0][0].event_type).toBe('submit');
  });

  it('preserves event order across flush failures', async () => {
    api.postShouldFail = true;
    logger.log('case_open');
    logger.log('slice_change', { slice: 1 });
    logger.log('slice_change', { slice: 2 });
    await expect(logger.flush()).rejects.toThrow();

    api.postShouldFail = false;
    await logger.flush();
    expect(api.posted[0].map(e => e.event_type)).toEqual([
      'case_open', 'slice_change', 'slice_change',
    ]);
  });

  it('forces an immediate flush when buffer hits maxBufferSize', async () => {
    logger.destroy();
    api = new StubApi();
    logger = new EventLogger({
      api: api as any,
      flushIntervalMs: 100_000,   // long enough that the timer can't trip
      maxBufferSize: 3,
      installUnloadHandlers: false,
    });
    logger.setSession(session);
    logger.setCurrentCase('case_x');

    logger.log('slice_change', { slice: 1 });
    logger.log('slice_change', { slice: 2 });
    logger.log('slice_change', { slice: 3 });   // triggers flush

    // Wait a tick for the microtask queue to drain.
    await new Promise(r => setTimeout(r, 0));
    expect(api.posted).toHaveLength(1);
    expect(api.posted[0]).toHaveLength(3);
  });

  it('flushBeacon ships pending events via navigator.sendBeacon', () => {
    logger.log('case_open');
    logger.log('case_close');
    const ok = logger.flushBeacon();
    expect(ok).toBe(true);
    expect(api.beaconed).toHaveLength(1);
    expect(api.beaconed[0]).toHaveLength(2);
    expect(logger.pendingCount).toBe(0);
  });

  it('flushBeacon re-queues events when sendBeacon refuses them', () => {
    api.beaconShouldFail = true;
    logger.log('case_close');
    const ok = logger.flushBeacon();
    expect(ok).toBe(false);
    expect(logger.pendingCount).toBe(1);
    expect(logger.stats.retries).toBe(1);
  });

  it('destroy() stops accepting new events', () => {
    logger.destroy();
    logger.log('case_open');
    expect(logger.pendingCount).toBe(0);
  });

  it('removes unload listeners when destroyed', () => {
    const addSpy = jest.spyOn(window, 'addEventListener');
    const removeSpy = jest.spyOn(window, 'removeEventListener');
    const l = new EventLogger({
      api: api as any,
      installUnloadHandlers: true,
    });

    l.destroy();

    const pagehideHandler = addSpy.mock.calls.find(call => call[0] === 'pagehide')?.[1];
    const beforeUnloadHandler = addSpy.mock.calls.find(call => call[0] === 'beforeunload')?.[1];
    expect(removeSpy).toHaveBeenCalledWith('pagehide', pagehideHandler);
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', beforeUnloadHandler);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('scheduled flush retries without surfacing an unhandled rejection', async () => {
    logger.destroy();
    api = new StubApi();
    api.postShouldFail = true;
    logger = new EventLogger({
      api: api as any,
      flushIntervalMs: 1,
      installUnloadHandlers: false,
    });
    logger.setSession(session);
    logger.setCurrentCase('case_x');

    logger.log('case_open');
    await new Promise(r => setTimeout(r, 20));

    expect(logger.pendingCount).toBe(1);
    expect(logger.stats.retries).toBe(1);
  });
});
