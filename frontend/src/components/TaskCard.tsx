import type { Task } from '../types/task'
import { ProgressBar } from './ProgressBar'
import { StatusBadge } from './StatusBadge'

export function TaskCard({
  task,
  active,
  onSelect,
}: {
  task: Task
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className={[
        'w-full rounded-xl border px-4 py-3 text-left shadow-sm transition-all',
        active
          ? 'border-[#00BAF2] bg-white shadow-md ring-2 ring-[#00BAF2]/25'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-medium text-[#002E7E]">{task.id}</p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-800">{task.name}</p>
        </div>
        <StatusBadge
          status={task.status}
          label={task.pipelineStatus === 'CLOSED' ? 'Closed' : undefined}
        />
      </div>
      <div className="mt-3">
        <ProgressBar value={task.progress} />
        <p className="mt-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          [{(task.pipelineStatus ?? task.status).toString().toUpperCase()}]
        </p>
      </div>
    </button>
  )
}
