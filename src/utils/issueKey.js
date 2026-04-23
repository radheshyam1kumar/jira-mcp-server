/** Jira-style keys, e.g. IPG-754, PG-3478 — same pattern as Bitbucket ticket branches. */
export const TICKET_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Normalize Jira issue key for pipeline DB (uppercase PROJECT-123). */
export function normalizeIssueKey(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*-\d+$/.test(t) ? t : null;
}

/** Parse keys like IPG-1096-dev or IPG-1096 from a branch name. */
export function extractIssueKeyFromBranchName(branch) {
  const b = String(branch ?? '').trim();
  const m = b.match(/^([A-Za-z][A-Za-z0-9]*-\d+)(?:-dev)?$/i);
  return m ? m[1].toUpperCase() : null;
}
