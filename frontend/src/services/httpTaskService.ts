import type { Task, TaskStatus } from '../types/task'
import type { JiraTicketDto } from '../types/jiraTicket'
import type { TaskAPI } from '../types/taskApi'

const API_BASE = (import.meta.env.VITE_PIPELINE_API_BASE_URL as string | undefined) ?? ''

function url(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${p}`
}

function parseIssueKeyFromInput(name: string): string | null {
  const m = name.trim().match(/\b([A-Za-z][A-Za-z0-9]*-\d+)\b/)
  return m ? m[1].toUpperCase() : null
}

function formatLogLine(entry: { at?: string; message?: string }): string {
  const raw = entry.at ? new Date(entry.at) : new Date()
  const hh = String(raw.getHours()).padStart(2, '0')
  const mm = String(raw.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}  ${entry.message ?? ''}`
}

function mapTicketToTask(t: JiraTicketDto): Task {
  const statusMap: Record<string, TaskStatus> = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CLOSED: 'completed',
  }
  const id = t.issueKey || t._id
  const prUrls = Array.from(
    new Set(
      [t.prUrl, ...(Array.isArray(t.prUrls) ? t.prUrls : [])]
        .map((x) => String(x || '').trim())
        .filter(Boolean),
    ),
  )
  return {
    id,
    name: (t.summary && t.summary.trim()) || id,
    status: statusMap[t.currentStatus] ?? 'running',
    progress: typeof t.progress === 'number' ? t.progress : 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    currentStatusDescription: t.currentStatusDescription,
    repository: t.repository,
    prUrl: prUrls[0] || undefined,
    prUrls: prUrls.length > 0 ? prUrls : undefined,
    stages: t.stages,
    jiraStatus: t.jiraStatus,
    activityLogs: Array.isArray(t.activityLogs) ? t.activityLogs.map(formatLogLine) : undefined,
    pipelineStatus: t.currentStatus,
  }
}

export class HttpTaskService implements TaskAPI {
  private async fetchTicketsList(): Promise<JiraTicketDto[]> {
    const res = await fetch(url('/api/jira-tickets'))
    if (!res.ok) throw new Error(`Failed to load jobs (${res.status}).`)
    return (await res.json()) as JiraTicketDto[]
  }

  async getTasks(): Promise<Task[]> {
    const rows = await this.fetchTicketsList()
    return rows.map(mapTicketToTask)
  }

  async getTaskById(id: string): Promise<Task> {
    const res = await fetch(url(`/api/jira-tickets/${encodeURIComponent(id)}`))
    if (res.status === 404) throw new Error(`Task not found: ${id}`)
    if (!res.ok) throw new Error(`Failed to load task (${res.status}).`)
    const row = (await res.json()) as JiraTicketDto
    return mapTicketToTask(row)
  }

  async createTask(payload: { name: string }): Promise<Task> {
    const key = parseIssueKeyFromInput(payload.name)
    if (!key) {
      throw new Error('Enter a Jira issue key such as IPG-1096.')
    }
    const res = await fetch(url('/api/jira-tickets/ensure'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueKey: key }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(errBody || `Could not register job (${res.status}).`)
    }
    const row = (await res.json()) as JiraTicketDto
    return mapTicketToTask(row)
  }

  async getTaskLogs(id: string): Promise<string[]> {
    const res = await fetch(url(`/api/jira-tickets/${encodeURIComponent(id)}`))
    if (!res.ok) throw new Error(`Task not found: ${id}`)
    const row = (await res.json()) as JiraTicketDto
    const logs = Array.isArray(row.activityLogs) ? row.activityLogs : []
    return logs.map(formatLogLine)
  }

  subscribeToTaskUpdates(callback: (update: Task) => void): void {
    // Selection-specific polling is handled in DashboardScreen.
    void callback
  }
}

export async function httpRetryFailedTask(issueKey: string): Promise<void> {
  const res = await fetch(url(`/api/jira-tickets/${encodeURIComponent(issueKey)}/retry`), {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Retry failed (${res.status}).`)
}
