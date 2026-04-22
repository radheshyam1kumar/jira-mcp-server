import { shallow } from 'zustand/vanilla/shallow'
import { createWithEqualityFn } from 'zustand/traditional'
import type { Task } from '../types/task'
import {
  getTaskService,
  retryFailedTask,
  setFailNextTaskListFetch,
} from '../services/taskService'

export type TaskFilter = 'all' | 'running' | 'completed'

type State = {
  tasksById: Record<string, Task>
  taskOrder: string[]
  selectedTaskId: string | null
  filter: TaskFilter
  search: string
  loading: boolean
  creating: boolean
  error: string | null
  subscriptionStarted: boolean
  initialized: boolean
}

type Actions = {
  initialize: () => Promise<void>
  refreshTasks: () => Promise<void>
  selectTask: (id: string | null) => void
  createTask: (name: string) => Promise<void>
  setFilter: (f: TaskFilter) => void
  setSearch: (q: string) => void
  retryTask: (id: string) => Promise<void>
  simulateListError: () => Promise<void>
  clearError: () => void
  upsertTask: (task: Task) => void
}

export type TaskDashboardStore = State & Actions

function sortIdsByUpdatedDesc(ids: string[], byId: Record<string, Task>): string[] {
  return [...ids].sort(
    (a, b) => new Date(byId[b]!.updatedAt).getTime() - new Date(byId[a]!.updatedAt).getTime(),
  )
}

let pendingInit: Promise<void> | null = null

export const useTaskDashboardStore = createWithEqualityFn<TaskDashboardStore>()(
  (set, get) => ({
  tasksById: {},
  taskOrder: [],
  selectedTaskId: null,
  filter: 'all',
  search: '',
  loading: false,
  creating: false,
  error: null,
  subscriptionStarted: false,
  initialized: false,

  upsertTask: (task) => {
    set((s) => {
      const tasksById = { ...s.tasksById, [task.id]: task }
      const has = s.taskOrder.includes(task.id)
      const taskOrder = has ? s.taskOrder : [task.id, ...s.taskOrder]
      const sorted = sortIdsByUpdatedDesc(taskOrder, tasksById)
      return { tasksById, taskOrder: sorted }
    })
  },

  clearError: () => set({ error: null }),

  initialize: async () => {
    if (get().initialized) return
    if (!pendingInit) {
      pendingInit = (async () => {
        set({ loading: true, error: null })
        try {
          const api = getTaskService()
          const tasks = await api.getTasks()
          const tasksById: Record<string, Task> = {}
          const taskOrder: string[] = []
          for (const t of tasks) {
            tasksById[t.id] = t
            taskOrder.push(t.id)
          }
          const sorted = sortIdsByUpdatedDesc(taskOrder, tasksById)
          const selectedTaskId = sorted[0] ?? null

          if (!get().subscriptionStarted) {
            api.subscribeToTaskUpdates((update) => {
              get().upsertTask(update)
            })
          }

          set({
            tasksById,
            taskOrder: sorted,
            loading: false,
            selectedTaskId,
            subscriptionStarted: true,
            initialized: true,
          })
        } catch (err) {
          set({
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load tasks.',
          })
        } finally {
          pendingInit = null
        }
      })()
    }
    await pendingInit
  },

  refreshTasks: async () => {
    set({ loading: true, error: null })
    try {
      const tasks = await getTaskService().getTasks()
      const tasksById: Record<string, Task> = {}
      const taskOrder: string[] = []
      for (const t of tasks) {
        tasksById[t.id] = t
        taskOrder.push(t.id)
      }
      const sorted = sortIdsByUpdatedDesc(taskOrder, tasksById)
      set((s) => ({
        tasksById,
        taskOrder: sorted,
        loading: false,
        selectedTaskId:
          s.selectedTaskId && sorted.includes(s.selectedTaskId)
            ? s.selectedTaskId
            : (sorted[0] ?? null),
      }))
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to refresh tasks.',
      })
    }
  },

  selectTask: (id) => set({ selectedTaskId: id }),

  createTask: async (name) => {
    set({ creating: true, error: null })
    try {
      const task = await getTaskService().createTask({ name })
      get().upsertTask(task)
      set({ selectedTaskId: task.id })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Could not create task.',
      })
    } finally {
      set({ creating: false })
    }
  },

  setFilter: (filter) => set({ filter }),

  setSearch: (search) => set({ search }),

  retryTask: async (id) => {
    set({ error: null })
    try {
      await retryFailedTask(id)
      await get().refreshTasks()
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Retry failed.',
      })
    }
  },

  simulateListError: async () => {
    setFailNextTaskListFetch(true)
    await get().refreshTasks()
  },
}),
  shallow,
)

export type TaskListViewState = Pick<
  TaskDashboardStore,
  'taskOrder' | 'tasksById' | 'filter' | 'search'
>

/** Derive filtered task list from list slice (use with `useMemo` + stable store fields). */
export function selectVisibleTasks(state: TaskListViewState): Task[] {
  const q = state.search.trim().toLowerCase()
  return state.taskOrder
    .map((id) => state.tasksById[id])
    .filter((t): t is Task => Boolean(t))
    .filter((t) => {
      if (q && !t.id.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) {
        return false
      }
      if (state.filter === 'all') return true
      if (state.filter === 'running') return t.status === 'pending' || t.status === 'running'
      if (state.filter === 'completed') return t.status === 'completed'
      return true
    })
}
