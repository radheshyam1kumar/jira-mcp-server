import type { Task } from './task'

/**
 * Contract for JRA-MCP-Server (or any) backend task APIs.
 * Swap `getTaskService()` implementation to plug in HTTP/WebSocket clients.
 */
export interface TaskAPI {
  getTasks(): Promise<Task[]>
  getTaskById(id: string): Promise<Task>
  createTask(payload: { name: string }): Promise<Task>
  getTaskLogs(id: string): Promise<string[]>
  subscribeToTaskUpdates(callback: (update: Task) => void): void
}
