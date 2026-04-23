import type { JiraTicketCostSummary, PipelineRunDto, PipelineStageRow } from './jiraTicket'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface Task {
  id: string
  name: string
  status: TaskStatus
  progress: number
  createdAt: string
  updatedAt: string
  pipelineStatus?: string
  currentStatusDescription?: string
  repository?: string
  prUrl?: string
  prUrls?: string[]
  stages?: PipelineStageRow[]
  jiraStatus?: string
  activityLogs?: string[]
  cost?: JiraTicketCostSummary
  /** Which Claude models wrote code (from API or derived from `pipelineRuns`). */
  codegenModels?: string[]
  pipelineRuns?: PipelineRunDto[]
  pipelineRunCount?: number
}
