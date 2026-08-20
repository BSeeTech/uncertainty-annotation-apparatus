/**
 * Small URL helpers shared by the worklist panel and the mode.
 *
 * Canonical route parameter: `caseId`.
 * Legacy alias still accepted while reading: `case_id`.
 */
export function getCaseIdFromUrl(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;

  const read = (params: URLSearchParams): string | null =>
    params.get('caseId') ?? params.get('case_id');

  const normal = read(new URLSearchParams(window.location.search ?? ''));
  if (normal) return normal;

  const hash = window.location.hash ?? '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return null;

  const hashSearch = hash.slice(queryIndex + 1).split('#')[0];
  return read(new URLSearchParams(hashSearch));
}

export function updateCaseIdInUrl(caseId: string): void {
  if (typeof window === 'undefined') return;
  const href = window.location?.href;
  const replaceState = window.history?.replaceState;
  if (!href || typeof replaceState !== 'function') return;

  const url = new URL(href);
  const apply = (params: URLSearchParams): void => {
    // Keep both route keys synchronized because OHIF mode code and backend
    // payloads still use both spellings at different boundaries.
    params.delete('caseId');
    params.delete('case_id');
    params.set('caseId', caseId);
    params.set('case_id', caseId);
  };

  const hash = url.hash ?? '';
  const hashWithoutSharp = hash.startsWith('#') ? hash.slice(1) : hash;
  const hashQueryIndex = hashWithoutSharp.indexOf('?');

  if (hashQueryIndex >= 0) {
    const hashPath = hashWithoutSharp.slice(0, hashQueryIndex);
    const hashSearch = hashWithoutSharp.slice(hashQueryIndex + 1);
    const params = new URLSearchParams(hashSearch);
    apply(params);
    const search = params.toString();
    url.hash = `#${hashPath}${search ? `?${search}` : ''}`;
  } else {
    apply(url.searchParams);
  }

  replaceState.call(window.history, null, '', url.toString());
}
