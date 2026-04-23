/**
 * Infer which Claude models were used for code-writing phases from persisted pipeline runs.
 * Matches common `phase` names from orchestrators; falls back to the phase with most completion tokens.
 */

const CODE_PHASE_PATTERN = /^(implement|code|development|generate|patch|coding)$/i;

/**
 * @param {Array<{ phases?: Array<{ phase?: string, model?: string, usage?: { completion_tokens?: number } }> }>} runsRaw
 * @returns {string[]} Distinct model ids, codegen phases first (document order).
 */
export function collectCodegenModelsFromRuns(runsRaw) {
  if (!Array.isArray(runsRaw) || runsRaw.length === 0) return [];

  const ordered = [];
  const seen = new Set();

  for (const run of runsRaw) {
    const phases = Array.isArray(run?.phases) ? run.phases : [];
    for (const ph of phases) {
      const model = ph?.model != null ? String(ph.model).trim() : '';
      if (!model) continue;
      const phase = String(ph?.phase || '');
      if (CODE_PHASE_PATTERN.test(phase) && !seen.has(model)) {
        seen.add(model);
        ordered.push(model);
      }
    }
  }

  if (ordered.length > 0) return ordered;

  let bestModel = '';
  let bestOut = -1;
  for (const run of runsRaw) {
    const phases = Array.isArray(run?.phases) ? run.phases : [];
    for (const ph of phases) {
      const model = ph?.model != null ? String(ph.model).trim() : '';
      if (!model) continue;
      const out = Number(ph?.usage?.completion_tokens);
      const o = Number.isFinite(out) && out >= 0 ? out : 0;
      if (o > bestOut) {
        bestOut = o;
        bestModel = model;
      }
    }
  }

  return bestModel ? [bestModel] : [];
}
