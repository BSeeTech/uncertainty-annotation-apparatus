import { getCaseIdFromUrl, updateCaseIdInUrl } from '../utils/caseUrl';

describe('caseUrl helpers', () => {
  const originalWindow = global.window;

  afterEach(() => {
    Object.defineProperty(global, 'window', {
      value: originalWindow,
      configurable: true,
    });
  });

  it('keeps caseId and case_id synchronized when updating a normal route', () => {
    const replaceState = jest.fn();
    Object.defineProperty(global, 'window', {
      value: {
        location: {
          href: 'http://localhost/uncertainty-review?reviewer=R01&condition=C2&case_id=old_case',
          search: '?reviewer=R01&condition=C2&case_id=old_case',
          hash: '',
        },
        history: { replaceState },
      },
      configurable: true,
    });

    updateCaseIdInUrl('case_001');

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      'http://localhost/uncertainty-review?reviewer=R01&condition=C2&caseId=case_001&case_id=case_001',
    );
  });

  it('prefers caseId when reading divergent route parameters', () => {
    Object.defineProperty(global, 'window', {
      value: {
        location: {
          search: '?case_id=old_case&caseId=case_001',
          hash: '',
        },
      },
      configurable: true,
    });

    expect(getCaseIdFromUrl()).toBe('case_001');
  });
});
