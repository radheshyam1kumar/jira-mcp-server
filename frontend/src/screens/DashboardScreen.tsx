import { useCallback, useEffect } from 'react'
import { TaskDetailsPanel } from '../components/TaskDetailsPanel'
import { TaskList } from '../components/TaskList'
import { useTaskDashboardStore } from '../hooks/useTaskDashboardStore'
import { getTaskService } from '../services/taskService'

function pathTaskId(): string | null {
  const raw = window.location.pathname.replace(/^\/+/, '').trim()
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function pathForTask(id: string): string {
  return `/${encodeURIComponent(id)}`
}

export function DashboardScreen() {
  const initialize = useTaskDashboardStore((s) => s.initialize)
  const refreshTasks = useTaskDashboardStore((s) => s.refreshTasks)
  const simulateListError = useTaskDashboardStore((s) => s.simulateListError)
  const clearError = useTaskDashboardStore((s) => s.clearError)
  const selectedTaskId = useTaskDashboardStore((s) => s.selectedTaskId)
  const tasksById = useTaskDashboardStore((s) => s.tasksById)
  const taskOrder = useTaskDashboardStore((s) => s.taskOrder)
  const selectTask = useTaskDashboardStore((s) => s.selectTask)
  const upsertTask = useTaskDashboardStore((s) => s.upsertTask)
  const loading = useTaskDashboardStore((s) => s.loading)
  const error = useTaskDashboardStore((s) => s.error)
  const initialized = useTaskDashboardStore((s) => s.initialized)

  const navigateToTask = useCallback(
    (taskId: string, replace = false) => {
      if (!taskId) return
      const target = pathForTask(taskId)
      if (window.location.pathname !== target) {
        if (replace) window.history.replaceState({}, '', target)
        else window.history.pushState({}, '', target)
      }
      selectTask(taskId)
    },
    [selectTask],
  )

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    if (!initialized) return

    const fromPath = pathTaskId()
    if (fromPath && tasksById[fromPath]) {
      if (selectedTaskId !== fromPath) selectTask(fromPath)
      return
    }

    const first = taskOrder[0] ?? null
    if (!first) {
      if (selectedTaskId) selectTask(null)
      return
    }

    if (!fromPath) {
      navigateToTask(first, true)
      return
    }

    if (selectedTaskId !== first) selectTask(first)
  }, [initialized, navigateToTask, selectTask, selectedTaskId, taskOrder, tasksById])

  useEffect(() => {
    const onPopState = () => {
      const fromPath = pathTaskId()
      if (fromPath) {
        if (tasksById[fromPath]) selectTask(fromPath)
      } else {
        selectTask(taskOrder[0] ?? null)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [selectTask, taskOrder, tasksById])

  useEffect(() => {
    if (!selectedTaskId) return

    let cancelled = false
    const pull = async () => {
      try {
        const latest = await getTaskService().getTaskById(selectedTaskId)
        if (!cancelled) upsertTask(latest)
      } catch {
        // Keep polling loop resilient even on transient API errors.
      }
    }

    void pull()
    const timer = window.setInterval(() => {
      void pull()
    }, 10_000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selectedTaskId, upsertTask])

  useEffect(() => {
    if (!selectedTaskId) return
    const target = pathForTask(selectedTaskId)
    if (window.location.pathname !== target) {
      window.history.replaceState({}, '', target)
    }
  }, [selectedTaskId])

  const selectedTask = selectedTaskId ? tasksById[selectedTaskId] ?? null : null

  return (
    <div className="flex min-h-dvh flex-col bg-[#F5F7F9] text-slate-800">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <img
            src="/paytm-logo.png"
            alt="Paytm"
            className="h-8 w-auto shrink-0 object-contain sm:h-9"
            width={120}
            height={36}
          />
          <div className="hidden min-w-0 border-l border-slate-200 pl-3 sm:block">
            <p className="truncate text-sm font-semibold text-[#002E7E]">DevOps Console</p>
            <p className="truncate text-xs text-slate-500">
              Pipelines - {import.meta.env.VITE_PIPELINE_MOCK === 'true' ? 'mock API' : 'Firestore API'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
            title="For demos: forces the next task list request to fail"
            onClick={() => void simulateListError()}
          >
            Demo: fail load
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void refreshTasks()}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-[#002E7E] shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Refreshing...' : 'Job History'}
          </button>
          <button
            type="button"
            className="rounded-lg bg-[#00BAF2] px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#00a8d9]"
            onClick={() => {
              alert('Settings will connect to JRA-MCP-Server configuration when available.')
            }}
          >
            Settings
          </button>
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-[#002E7E] shadow-sm hover:bg-slate-50"
            aria-label="Help"
            onClick={() => {
              alert('Help: wire `getTaskService()` to your backend and implement `TaskAPI`.')
            }}
          >
            ?
          </button>
        </div>
      </header>

      {error ? (
        <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 sm:mx-6">
          <p className="min-w-0 flex-1">{error}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg bg-[#00BAF2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#00a8d9]"
              onClick={() => void refreshTasks()}
            >
              Retry fetch
            </button>
            <button
              type="button"
              className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-800 hover:bg-rose-50"
              onClick={() => void simulateListError()}
            >
              Fail again (demo)
            </button>
            <button
              type="button"
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              onClick={() => clearError()}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 w-full shrink-0 border-slate-200 bg-white lg:h-auto lg:w-[min(380px,42vw)] lg:border-r lg:shadow-sm">
          <TaskList onSelectTask={(id) => navigateToTask(id)} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4 lg:p-6">
          {!initialized && loading ? (
            <div className="flex min-h-[40vh] flex-1 items-center justify-center rounded-xl border border-slate-200 bg-white p-10 text-sm text-slate-500 shadow-sm">
              Loading tasks...
            </div>
          ) : (
            <TaskDetailsPanel task={selectedTask} />
          )}
        </div>
      </main>
    </div>
  )
}
