import type { Task } from '../types/task'

/** Fallback steps when the API has not returned `task.stages` yet. */
export const PIPELINE_STEPS = [
  'Fetch Jira Ticket',
  'Analyze Jira Info',
  'Development',
  'Commit',
  'PR Raised',
  'PR Merged',
  'Build',
  'Deployed',
] as const

export function pipelineStepLabel(progress: number, status: 'failed' | 'completed' | string): string {
  const n = PIPELINE_STEPS.length
  if (status === 'completed') return `Step ${n} of ${n}: ${PIPELINE_STEPS[n - 1]}`
  if (status === 'failed') return 'Pipeline stopped due to an error.'
  const step = Math.min(n, Math.max(1, Math.ceil((progress / 100) * n)))
  return `Step ${step} of ${n}: ${PIPELINE_STEPS[step - 1]}`
}

export function statusLineFromTask(task: Task): string {
  const d = task.currentStatusDescription?.trim()
  if (d) return d
  if (task.status === 'failed') return 'Pipeline stopped due to an error.'
  if (task.pipelineStatus === 'CLOSED') return 'Pipeline completed successfully — ticket closed.'
  if (Array.isArray(task.stages) && task.stages.length > 0) {
    const rows = task.stages
    const firstIncomplete = rows.findIndex(
      (s) => s.status === 'PENDING' || s.status === 'IN_PROGRESS' || s.status === 'FAILED',
    )
    const n = rows.length
    if (firstIncomplete === -1) {
      const last = rows[n - 1]
      return `Step ${n} of ${n}: ${last?.label ?? PIPELINE_STEPS[n - 1]}`
    }
    const cur = rows[firstIncomplete]
    return `Step ${firstIncomplete + 1} of ${n}: ${cur?.label ?? PIPELINE_STEPS[firstIncomplete] ?? ''}`
  }
  return pipelineStepLabel(task.progress, task.status)
}
