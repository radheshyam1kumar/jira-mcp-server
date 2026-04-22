import { useMemo, useState } from 'react'
import type { Task } from '../types/task'
import type { TaskFilter } from '../hooks/useTaskDashboardStore'
import { selectVisibleTasks, useTaskDashboardStore } from '../hooks/useTaskDashboardStore'
import { TaskCard } from './TaskCard'

const FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'completed', label: 'Completed' },
]

export function TaskList({ onSelectTask }: { onSelectTask?: (id: string) => void }) {
  const [draftName, setDraftName] = useState('')
  const taskOrder = useTaskDashboardStore((s) => s.taskOrder)
  const tasksById = useTaskDashboardStore((s) => s.tasksById)
  const filter = useTaskDashboardStore((s) => s.filter)
  const search = useTaskDashboardStore((s) => s.search)
  const setFilter = useTaskDashboardStore((s) => s.setFilter)
  const setSearch = useTaskDashboardStore((s) => s.setSearch)
  const tasks = useMemo(
    () => selectVisibleTasks({ taskOrder, tasksById, filter, search }),
    [taskOrder, tasksById, filter, search],
  )
  const selectedTaskId = useTaskDashboardStore((s) => s.selectedTaskId)
  const selectTask = useTaskDashboardStore((s) => s.selectTask)
  const createTask = useTaskDashboardStore((s) => s.createTask)
  const creating = useTaskDashboardStore((s) => s.creating)

  const empty = useMemo(() => tasks.length === 0, [tasks.length])

  const onCreate = async () => {
    const name = draftName.trim()
    if (!name) return
    await createTask(name)
    setDraftName('')
  }

  return (
    <aside className="flex min-h-0 w-full flex-1 flex-col bg-white lg:min-h-0">
      <div className="border-b border-slate-100 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-[#002E7E]">Your jobs</h2>
        </div>

        <div className="mt-3 flex gap-1 rounded-xl bg-[#F5F7F9] p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={[
                'flex-1 rounded-lg px-2 py-2 text-xs font-semibold transition-colors',
                filter === f.id
                  ? 'bg-white text-[#002E7E] shadow-sm ring-1 ring-[#00BAF2]/40'
                  : 'text-slate-600 hover:text-[#002E7E]',
              ].join(' ')}
            >
              {f.label}
            </button>
          ))}
        </div>

        <label className="mt-3 block text-xs font-medium text-slate-500" htmlFor="task-search">
          Search by ID or name
        </label>
        <input
          id="task-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="e.g. PROJ-3423"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none ring-[#00BAF2]/30 placeholder:text-slate-400 focus:ring-2"
        />

        <div className="mt-4 flex gap-2">
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onCreate()
            }}
            placeholder="Jira key e.g. IPG-1096"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none ring-[#00BAF2]/30 placeholder:text-slate-400 focus:ring-2"
          />
          <button
            type="button"
            disabled={creating || !draftName.trim()}
            onClick={() => void onCreate()}
            className="shrink-0 rounded-lg bg-[#00BAF2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#00a8d9] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {creating ? '…' : 'Create'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[#F5F7F9] p-3">
        {empty ? (
          <p className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No tasks match this view.
          </p>
        ) : (
          tasks.map((task: Task) => (
            <TaskCard
              key={task.id}
              task={task}
              active={task.id === selectedTaskId}
              onSelect={(id) => {
                if (onSelectTask) onSelectTask(id)
                else selectTask(id)
              }}
            />
          ))
        )}
      </div>
    </aside>
  )
}
