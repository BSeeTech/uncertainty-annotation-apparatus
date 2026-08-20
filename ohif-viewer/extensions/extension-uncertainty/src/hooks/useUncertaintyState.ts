import { useEffect, useState } from 'react';
import type { UncertaintyService, UncertaintyState } from '../services/UncertaintyService';

/**
 * Subscribe a React component to the `UncertaintyService` state bus.
 *
 * The hook re-renders the component whenever the service publishes a
 * new state.  We intentionally do NOT use `useSyncExternalStore` so
 * the hook works on React 17 (still common in OHIF v3.7 deployments).
 */
export function useUncertaintyState(service: UncertaintyService): UncertaintyState {
  const [state, setState] = useState<UncertaintyState>(() => service.getState());
  useEffect(() => {
    setState(service.getState());     // sync any state set between render and effect
    return service.subscribe(setState);
  }, [service]);
  return state;
}
