import { parseSessionFromSearch, describeSession } from '../sessionConfig';

describe('parseSessionFromSearch', () => {
  it('parses a complete URL', () => {
    expect(parseSessionFromSearch('?reviewer=R03&condition=C2')).toEqual({
      reviewerId: 'R03',
      condition: 'C2',
      initialCaseId: null,
    });
  });

  it('handles missing leading "?"', () => {
    expect(parseSessionFromSearch('reviewer=R01&condition=C0')).toEqual({
      reviewerId: 'R01',
      condition: 'C0',
      initialCaseId: null,
    });
  });

  it('captures caseId when present', () => {
    expect(parseSessionFromSearch('?reviewer=R01&condition=C2&caseId=case_007')).toEqual({
      reviewerId: 'R01',
      condition: 'C2',
      initialCaseId: 'case_007',
    });
  });

  it('also accepts case_id as snake_case alias', () => {
    expect(parseSessionFromSearch('?reviewer=R01&condition=C1&case_id=case_42')).toEqual({
      reviewerId: 'R01',
      condition: 'C1',
      initialCaseId: 'case_42',
    });
  });

  it('returns null when reviewer is missing', () => {
    expect(parseSessionFromSearch('?condition=C2')).toBeNull();
  });

  it('returns null when condition is missing', () => {
    expect(parseSessionFromSearch('?reviewer=R01')).toBeNull();
  });

  it('returns null on invalid condition', () => {
    expect(parseSessionFromSearch('?reviewer=R01&condition=C9')).toBeNull();
    expect(parseSessionFromSearch('?reviewer=R01&condition=c2')).toBeNull(); // case-sensitive
  });

  it('returns null on a reviewer id with disallowed characters', () => {
    expect(parseSessionFromSearch('?reviewer=R%2003&condition=C2')).toBeNull();
    expect(parseSessionFromSearch('?reviewer=&condition=C2')).toBeNull();
    expect(parseSessionFromSearch('?reviewer=R 03&condition=C2')).toBeNull();
    expect(parseSessionFromSearch('?reviewer=' + 'X'.repeat(33) + '&condition=C2')).toBeNull();
  });

  it('returns null on an empty search string', () => {
    expect(parseSessionFromSearch('')).toBeNull();
    expect(parseSessionFromSearch('?')).toBeNull();
  });

  it('accepts dot, underscore, hyphen in reviewer id', () => {
    const s = parseSessionFromSearch('?reviewer=R-03_alt.1&condition=C2');
    expect(s?.reviewerId).toBe('R-03_alt.1');
  });
});

describe('describeSession', () => {
  it('produces a stable, human-readable string', () => {
    expect(describeSession({
      reviewerId: 'R03',
      condition: 'C2',
      initialCaseId: null,
    })).toBe('Reviewer R03 · Condition C2');
  });
});
