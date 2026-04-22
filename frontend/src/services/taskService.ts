import type { TaskAPI } from '../types/taskApi'
import { MockTaskService } from '../mocks/mockTaskService'
import { HttpTaskService, httpRetryFailedTask } from './httpTaskService'

/**
 * Single composition root for task data access.
 * Set `VITE_PIPELINE_MOCK=true` to use the in-browser mock service instead of the REST API.
 */
let singleton: MockTaskService | HttpTaskService | null = null

export function getTaskService(): TaskAPI {
  if (!singleton) {
    const useMock = import.meta.env.VITE_PIPELINE_MOCK === 'true'
    singleton = useMock ? new MockTaskService() : new HttpTaskService()
  }
  return singleton
}

export async function retryFailedTask(id: string): Promise<void> {
  const svc = getTaskServiceInternal()
  if (svc instanceof HttpTaskService) {
    await httpRetryFailedTask(id)
    return
  }
  await svc.retryFailedTask(id)
}

/** Toggle for UI demos of list error handling (mock service only). */
export function setFailNextTaskListFetch(shouldFail: boolean): void {
  const svc = getTaskServiceInternal()
  if (svc instanceof MockTaskService) svc.failNextList = shouldFail
}

function getTaskServiceInternal(): MockTaskService | HttpTaskService {
  if (!singleton) {
    const useMock = import.meta.env.VITE_PIPELINE_MOCK === 'true'
    singleton = useMock ? new MockTaskService() : new HttpTaskService()
  }
  return singleton
}
