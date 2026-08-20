/**
 * Session-config parsing helpers.
 *
 * The user study switches between the C0/C1/C2 conditions by URL
 * parameter alone — no code changes between conditions, no UI for the
 * reviewer to choose.  This file is the single place that decides
 * what those URL parameters mean.
 *
 * URL contract:
 *   ?reviewer=R03&condition=C2[&caseId=case_001]
 *
 * - `reviewer`   — required; the reviewer ID logged with every event.
 * - `condition`  — required; one of C0, C1, C2, C3, C4, C5 (LR §2.9.2).
 * - `caseId`     — optional; if present, the mode auto-opens the case.
 *                 The legacy snake_case `case_id` alias is still accepted.
 *
 * The function is deliberately strict: any malformed value yields
 * `null` rather than a partial parse, so the host can fall back to a
 * "configure this session" splash screen and the user study isn't
 * silently corrupted by a typo in a URL.
 */

import type { Condition } from '@thesis/extension-uncertainty';

export interface SessionConfig {
  reviewerId: string;
  condition: Condition;
  /** Optional initial case to open on mode entry. */
  initialCaseId: string | null;
}

const VALID_CONDITIONS: ReadonlySet<string> = new Set(['C0', 'C1', 'C2', 'C3', 'C4', 'C5']);

// Reviewer IDs are restricted to a conservative alphanumeric form so
// they round-trip safely through URLs, log files, and CSV exports
// without ambiguity.  Tighten or loosen here if your study allocates
// IDs that need different characters.
const REVIEWER_ID_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

export function parseSessionFromSearch(search: string): SessionConfig | null {
  if (!search) return null;

  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const reviewer = params.get('reviewer');
  const condition = params.get('condition');
  const caseId = params.get('caseId') || params.get('case_id');

  if (!reviewer || !REVIEWER_ID_PATTERN.test(reviewer)) return null;
  if (!condition || !VALID_CONDITIONS.has(condition)) return null;

  return {
    reviewerId: reviewer,
    condition: condition as Condition,
    initialCaseId: caseId ?? null,
  };
}

/**
 * Pretty-print a session for the page header.
 *
 * Why a helper instead of inline JSX: this string ends up in the
 * browser tab title via `document.title`, in the page header banner,
 * and in screenshots used in the thesis.  Keeping the format in one
 * place means those three views never disagree about what condition
 * is active.
 */
export function describeSession(s: SessionConfig): string {
  return `Reviewer ${s.reviewerId} · Condition ${s.condition}`;
}
