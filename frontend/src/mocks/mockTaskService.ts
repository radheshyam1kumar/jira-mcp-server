import type { Task, TaskStatus } from '../types/task'
import type { TaskAPI } from '../types/taskApi'

function nowIso(): string {
  return new Date().toISOString()
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const LOG_TEMPLATES = [
  'Fetching Jira ticket metadata…',
  'Resolving repository default branch…',
  'Pulling latest Figma frame…',
  'Analyzing repository structure…',
  'Generating component scaffold…',
  'Running static checks…',
  'Opening pull request…',
  'Waiting for CI pipeline…',
  'Preparing deployment artifact…',
]

export class MockTaskService implements TaskAPI {
  private tasks = new Map<string, Task>()
  private logs = new Map<string, string[]>()
  private listeners = new Set<(update: Task) => void>()
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private pendingStarts = new Map<string, ReturnType<typeof setTimeout>>()
  /** When true, next `getTasks` rejects once (for UI error handling demos). */
  public failNextList = false

  constructor() {
    this.seedInitialTasks()
  }

  private seedInitialTasks(): void {
    const t1 = this.buildTask({
      id: 'PROJ-3423',
      name: 'Implement new feature',
      status: 'running',
      progress: 42,
    })
    const t2 = this.buildTask({
      id: 'PROJ-3310',
      name: 'Fix regression in checkout',
      status: 'completed',
      progress: 100,
    })
    const t3 = this.buildTask({
      id: 'PROJ-3299',
      name: 'Refactor auth middleware',
      status: 'failed',
      progress: 68,
    })
    this.tasks.set(t1.id, t1)
    this.tasks.set(t2.id, t2)
    this.tasks.set(t3.id, t3)
    this.bootstrapLogs(t1.id, 'running', 42)
    this.bootstrapLogs(t2.id, 'completed', 100)
    this.bootstrapLogs(t3.id, 'failed', 68)
    this.startSimulation(t1.id)
  }

  private buildTask(partial: Omit<Task, 'createdAt' | 'updatedAt'> & Partial<Pick<Task, 'createdAt' | 'updatedAt'>>): Task {
    const ts = partial.createdAt ?? nowIso()
    return {
      createdAt: ts,
      updatedAt: partial.updatedAt ?? ts,
      ...partial,
    }
  }

  private bootstrapLogs(id: string, status: TaskStatus, progress: number): void {
    const lines: string[] = []
    const stamp = (m: string) => `${this.timeLabel()}  ${m}`
    lines.push(stamp('Job accepted by orchestrator.'))
    lines.push(stamp('Fetching Jira ticket…'))
    lines.push(stamp('Extracting Figma design tokens…'))
    if (progress > 25) lines.push(stamp('Mapping design to component tree…'))
    if (progress > 45) lines.push(stamp('Generating code (iterative pass)…'))
    if (status === 'failed') {
      lines.push(stamp('CI failed: type errors in generated module.'))
    }
    if (status === 'completed') {
      lines.push(stamp('Pull request merged.'))
      lines.push(stamp('Deployment queued.'))
    }
    this.logs.set(id, lines)
  }

  private timeLabel(): string {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  private notify(update: Task): void {
    for (const cb of this.listeners) {
      cb(update)
    }
  }

  private pushLog(id: string, message: string): void {
    const list = this.logs.get(id) ?? []
    const line = `${this.timeLabel()}  ${message}`
    list.push(line)
    this.logs.set(id, list)
  }

  private patchTask(id: string, patch: Partial<Task>): Task {
    const prev = this.tasks.get(id)
    if (!prev) throw new Error(`Unknown task: ${id}`)
    const next: Task = {
      ...prev,
      ...patch,
      updatedAt: nowIso(),
    }
    this.tasks.set(id, next)
    this.notify(next)
    return next
  }

  async getTasks(): Promise<Task[]> {
    await this.delay(320)
    if (this.failNextList) {
      this.failNextList = false
      throw new Error('Unable to reach task service (simulated).')
    }
    return [...this.tasks.values()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
  }

  async getTaskById(id: string): Promise<Task> {
    await this.delay(120)
    const t = this.tasks.get(id)
    if (!t) throw new Error(`Task not found: ${id}`)
    return { ...t }
  }

  async createTask(payload: { name: string }): Promise<Task> {
    await this.delay(200)
    const name = payload.name.trim()
    if (!name) throw new Error('Task name is required.')

    const id = `JOB-${randomId().slice(0, 8)}`
    const task = this.buildTask({
      id,
      name,
      status: 'pending',
      progress: 0,
    })
    this.tasks.set(id, task)
    this.logs.set(id, [`${this.timeLabel()}  Job queued.`])
    this.notify(task)

    const start = setTimeout(() => {
      this.pendingStarts.delete(id)
      this.patchTask(id, { status: 'running', progress: 4 })
      this.pushLog(id, 'Starting pipeline…')
      this.startSimulation(id)
    }, 900)
    this.pendingStarts.set(id, start)

    return { ...task }
  }

  async getTaskLogs(id: string): Promise<string[]> {
    await this.delay(80)
    if (!this.tasks.has(id)) throw new Error(`Task not found: ${id}`)
    return [...(this.logs.get(id) ?? [])]
  }

  subscribeToTaskUpdates(callback: (update: Task) => void): void {
    this.listeners.add(callback)
  }

  /**
   * Not part of `TaskAPI`; wire through `retryFailedTask` in `services/taskService.ts`
   * until the backend exposes a stable endpoint.
   */
  async retryFailedTask(id: string): Promise<void> {
    await this.delay(160)
    const t = this.tasks.get(id)
    if (!t) throw new Error(`Task not found: ${id}`)
    if (t.status !== 'failed') throw new Error('Only failed tasks can be retried.')

    this.clearTimers(id)
    this.patchTask(id, { status: 'pending', progress: 0 })
    this.pushLog(id, 'Retry requested — resetting pipeline.')

    const start = setTimeout(() => {
      this.pendingStarts.delete(id)
      this.patchTask(id, { status: 'running', progress: 6 })
      this.pushLog(id, 'Restarting after failure…')
      this.startSimulation(id, { forceSuccess: true })
    }, 700)
    this.pendingStarts.set(id, start)
  }

  private clearTimers(id: string): void {
    const t = this.timers.get(id)
    if (t) clearInterval(t)
    this.timers.delete(id)
    const p = this.pendingStarts.get(id)
    if (p) clearTimeout(p)
    this.pendingStarts.delete(id)
  }

  private startSimulation(id: string, opts?: { forceSuccess?: boolean }): void {
    if (this.timers.has(id)) return

    const tick = () => {
      const task = this.tasks.get(id)
      if (!task || task.status === 'completed' || task.status === 'failed') {
        this.clearTimers(id)
        return
      }
      if (task.status !== 'running') return

      const increment = 4 + Math.floor(Math.random() * 9)
      let nextProgress = Math.min(100, task.progress + increment)

      if (nextProgress >= 100) {
        nextProgress = 100
        this.patchTask(id, { progress: 100, status: 'completed' })
        this.pushLog(id, 'Pipeline completed successfully.')
        this.pushLog(id, 'Pull request is ready for review.')
        this.clearTimers(id)
        return
      }

      const shouldFail =
        !opts?.forceSuccess &&
        task.progress > 72 &&
        nextProgress > 88 &&
        Math.random() < 0.12

      if (shouldFail) {
        this.patchTask(id, { progress: nextProgress, status: 'failed' })
        this.pushLog(id, 'Deployment step failed (simulated).')
        this.clearTimers(id)
        return
      }

      this.patchTask(id, { progress: nextProgress })

      if (Math.random() < 0.45) {
        const msg = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)] ?? 'Working…'
        this.pushLog(id, msg)
      }
    }

    const handle = setInterval(tick, 650)
    this.timers.set(id, handle)
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
