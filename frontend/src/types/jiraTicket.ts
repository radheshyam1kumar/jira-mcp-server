export type JiraTicketCurrentStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CLOSED'

export type PipelineStageStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED'

export interface PipelineStageRow {
  id: string
  label: string
  status: PipelineStageStatus
}

export interface JiraActivityLogLine {
  at: string
  message: string
}

export interface PipelinePhaseUsageRow {
  phase: string
  model: string
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  cost_usd: number
}

export interface PipelineRunCost {
  current_run_usd: number
  all_runs_usd: number
  total_tokens: number
}

export interface PipelineRunDto {
  runId: string
  startedAt: string
  completedAt?: string | null
  phases: PipelinePhaseUsageRow[]
  cost: PipelineRunCost
}

export interface JiraTicketCostSummary {
  all_runs_usd: number
  total_tokens: number
  run_count: number
}

export interface JiraTicketDto {
  _id: string
  issueKey: string
  userId: string
  summary: string
  jiraStatus: string
  descriptionPreview?: string
  repository?: string
  prUrl?: string
  prUrls?: string[]
  activityLogs?: JiraActivityLogLine[]
  activityLogCount?: number
  pipelineRunCount?: number
  pipelineRuns?: PipelineRunDto[]
  cost?: JiraTicketCostSummary
  /** Models inferred from codegen-like LLM phases (see backend `codegenModels.js`). */
  codegenModels?: string[]
  stages?: PipelineStageRow[]
  currentStatus: JiraTicketCurrentStatus
  currentStatusDescription?: string
  progress: number
  createdAt: string
  updatedAt: string
}
