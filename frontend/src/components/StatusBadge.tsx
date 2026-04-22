import type { TaskStatus } from '../types/task'

const STYLES: Record<
  TaskStatus,
  { label: string; className: string }
> = {
  pending: {
    label: 'Pending',
    className: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  },
  running: {
    label: 'Running',
    className: 'bg-sky-50 text-[#002E7E] ring-1 ring-[#00BAF2]/50',
  },
  completed: {
    label: 'Completed',
    className: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  },
  failed: {
    label: 'Failed',
    className: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200',
  },
}

export function StatusBadge({ status, label }: { status: TaskStatus; label?: string }) {
  const cfg = STYLES[status]
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tracking-wide uppercase ${cfg.className}`}
    >
      {label ?? cfg.label}
    </span>
  )
}
