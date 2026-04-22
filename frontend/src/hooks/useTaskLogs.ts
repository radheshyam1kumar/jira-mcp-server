import { useMemo } from 'react'
import type { Task } from '../types/task'

export function useTaskLogs(task: Task | null): {
  lines: string[]
  loading: boolean
  error: string | null
} {
  const lines = useMemo(() => (task?.activityLogs ? task.activityLogs : []), [task?.activityLogs])
  return { lines, loading: false, error: null }
}
