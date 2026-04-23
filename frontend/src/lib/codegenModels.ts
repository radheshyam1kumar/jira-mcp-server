import type { PipelineRunDto } from '../types/jiraTicket'

/** Phase names commonly used for code-writing (orchestrator `LLM_USAGE` `phase` field). */
const CODE_PHASE = /^(implement|code|development|generate|patch|coding)$/i

/**
 * Derive distinct model ids used for codegen-like phases (client-side fallback when API omits `codegenModels`).
 */
export function codegenModelsFromPipelineRuns(runs: PipelineRunDto[] | undefined): string[] {
  if (!runs?.length) return []
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const run of runs) {
    for (const ph of run.phases || []) {
      const m = ph.model?.trim()
      if (!m) continue
      if (CODE_PHASE.test(String(ph.phase || '')) && !seen.has(m)) {
        seen.add(m)
        ordered.push(m)
      }
    }
  }
  if (ordered.length > 0) return ordered

  let best = ''
  let bestOut = -1
  for (const run of runs) {
    for (const ph of run.phases || []) {
      const m = ph.model?.trim()
      if (!m) continue
      const out = Number(ph.usage?.completion_tokens) || 0
      if (out > bestOut) {
        bestOut = out
        best = m
      }
    }
  }
  return best ? [best] : []
}

export function formatCodegenModelsLabel(models: string[] | undefined): string {
  if (!models?.length) return '—'
  return models.join(', ')
}
