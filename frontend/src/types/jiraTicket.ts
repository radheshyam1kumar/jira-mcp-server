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
  stages?: PipelineStageRow[]
  currentStatus: JiraTicketCurrentStatus
  currentStatusDescription?: string
  progress: number
  createdAt: string
  updatedAt: string
}
