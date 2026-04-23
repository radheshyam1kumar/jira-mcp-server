import { formatCodegenModelsLabel } from '../lib/codegenModels'
import { formatTokens, formatUsd } from '../lib/formatLlmCost'
import { PIPELINE_STEPS, statusLineFromTask } from '../lib/pipeline'
import type { Task } from '../types/task'
import { useTaskLogs } from '../hooks/useTaskLogs'
import { useTaskDashboardStore } from '../hooks/useTaskDashboardStore'
import { LogsViewer } from './LogsViewer'
import { ProgressBar } from './ProgressBar'
import { StatusBadge } from './StatusBadge'

function repoSlugFromTask(task: Task): string {
  const r = task.repository?.trim()
  if (r) return r
  const slug = task.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return slug || 'app-repo'
}

export function TaskDetailsPanel({ task }: { task: Task | null }) {
  if (!task) {
    return (
      <section className="flex min-h-[40vh] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500 shadow-sm">
        Select a job to inspect pipeline progress, logs, and deployment status.
      </section>
    )
  }

  return <TaskDetailsBody task={task} />
}

function TaskDetailsBody({ task }: { task: Task }) {
  const { lines, loading, error } = useTaskLogs(task)
  const retryTask = useTaskDashboardStore((s) => s.retryTask)
  const refreshTasks = useTaskDashboardStore((s) => s.refreshTasks)

  const repo = repoSlugFromTask(task)
  const prUrls = Array.from(
    new Set(
      [task.prUrl, ...(Array.isArray(task.prUrls) ? task.prUrls : [])]
        .map((u) => String(u || '').trim())
        .filter(Boolean),
    ),
  )
  const latestPrUrl = prUrls[0] ?? null

  const stageRows =
    task.stages && task.stages.length > 0
      ? task.stages
      : PIPELINE_STEPS.map((label, i) => ({
          id: `fallback-${i}`,
          label,
          status: 'PENDING' as const,
        }))

  const stepIndex = (() => {
    const n = stageRows.length
    if (task.status === 'completed' || task.pipelineStatus === 'CLOSED') return n
    if (task.status === 'failed') {
      const failedIdx = stageRows.findIndex((s) => s.status === 'FAILED')
      if (failedIdx >= 0) return Math.min(n, failedIdx + 1)
      return Math.min(n, Math.max(1, Math.ceil((task.progress / 100) * n)))
    }
    const firstIncomplete = stageRows.findIndex(
      (s) => s.status === 'PENDING' || s.status === 'IN_PROGRESS' || s.status === 'FAILED',
    )
    if (firstIncomplete === -1) return n
    return firstIncomplete + 1
  })()

  const firstIncompleteIdx = stageRows.findIndex(
    (s) => s.status === 'PENDING' || s.status === 'IN_PROGRESS' || s.status === 'FAILED',
  )
  const frontier = firstIncompleteIdx === -1 ? stageRows.length : firstIncompleteIdx

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="shrink-0 space-y-2 border-b border-slate-100 pb-4">
        <h2 className="text-lg font-bold text-[#002E7E]">
          Job details — <span className="font-mono font-semibold text-[#00BAF2]">{task.id}</span>
        </h2>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-700">
          <p>
            <span className="text-slate-500">Repo:</span>{' '}
            <span className="font-mono font-medium text-slate-800">{repo}</span>
          </p>
          <p className="flex items-center gap-2">
            <span className="text-slate-500">Status:</span>{' '}
            <StatusBadge
              status={task.status}
              label={task.pipelineStatus === 'CLOSED' ? 'Closed' : undefined}
            />
          </p>
          {task.jiraStatus ? (
            <p>
              <span className="text-slate-500">Jira workflow:</span>{' '}
              <span className="font-medium text-slate-800">{task.jiraStatus}</span>
            </p>
          ) : null}
          <p className="basis-full sm:basis-auto">
            <span className="text-slate-500">Code from LLM:</span>{' '}
            <span className="font-mono font-medium text-slate-900">
              {formatCodegenModelsLabel(task.codegenModels)}
            </span>
          </p>
          <p>
            <span className="text-slate-500">Job ID:</span>{' '}
            <span className="font-mono font-medium text-slate-800">{shortId(task.id)}</span>
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-sky-50/40 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#002E7E]">LLM tokens & cost</p>
          <p className="mt-2 text-sm text-slate-700">
            <span className="text-slate-500">Total tokens (all runs):</span>{' '}
            <span className="font-mono font-semibold text-slate-900">
              {formatTokens(task.cost?.total_tokens ?? 0)}
            </span>
          </p>
          <p className="mt-1 text-sm text-slate-700">
            <span className="text-slate-500">Total cost (est.):</span>{' '}
            <span className="font-mono font-semibold text-slate-900">
              {formatUsd(task.cost?.all_runs_usd ?? 0)}
            </span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Runs: {task.cost?.run_count ?? task.pipelineRunCount ?? 0}. Updates when the orchestrator sends{' '}
            <span className="font-mono">LLM_USAGE</span> to the pipeline API.
          </p>
          {task.pipelineRuns && task.pipelineRuns.length > 0 ? (
            <div className="mt-4 space-y-4 border-t border-slate-200/80 pt-4">
              {task.pipelineRuns.map((run, runIdx) => (
                <div key={run.runId || `run-${runIdx}`} className="rounded-lg border border-slate-200 bg-white/90 p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-mono text-xs font-semibold text-[#002E7E]">
                      Run {runIdx + 1}
                      <span className="font-normal text-slate-500">
                        {run.startedAt ? ` · ${run.startedAt.slice(0, 19)}` : ''}
                        {run.completedAt ? ` → ${run.completedAt.slice(0, 19)}` : ' · open'}
                      </span>
                    </p>
                    <p className="text-xs text-slate-600">
                      {formatTokens(run.cost?.total_tokens ?? 0)} tok · {formatUsd(run.cost?.current_run_usd ?? 0)}
                      <span className="text-slate-400"> (this run)</span>
                    </p>
                  </div>
                  {run.phases && run.phases.length > 0 ? (
                    <ul className="mt-2 space-y-1.5 border-t border-slate-100 pt-2 text-xs">
                      {run.phases.map((ph) => (
                        <li
                          key={`${run.runId}-${ph.phase}-${ph.model}`}
                          className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-slate-700"
                        >
                          <span>
                            <span className="font-medium text-slate-900">{ph.phase}</span>
                            <span className="text-slate-400"> · </span>
                            <span className="font-mono text-slate-600">{ph.model}</span>
                          </span>
                          <span className="font-mono text-slate-800">
                            in {formatTokens(ph.usage?.prompt_tokens ?? 0)} / out{' '}
                            {formatTokens(ph.usage?.completion_tokens ?? 0)} · {formatUsd(ph.cost_usd ?? 0)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">No LLM usage recorded for this run yet.</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-500">
              Open this job (detail poll loads full ticket) to see per-run phases when the backend stores{' '}
              <span className="font-mono">pipelineRuns</span>.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-[#F5F7F9] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#002E7E]">Current stage</p>
          <ol className="mt-3 grid gap-2 sm:grid-cols-2">
            {stageRows.map((row, idx) => {
              const failed = row.status === 'FAILED'
              const done =
                failed ||
                task.pipelineStatus === 'CLOSED' ||
                task.status === 'completed' ||
                (row.status === 'SUCCESS' && idx < frontier)
              const current =
                task.status !== 'completed' &&
                task.pipelineStatus !== 'CLOSED' &&
                !failed &&
                idx === stepIndex - 1
              return (
                <li key={row.id} className="flex items-center gap-2 text-sm text-slate-800">
                  <span
                    className={[
                      'inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px]',
                      failed
                        ? 'border-rose-300 bg-rose-50 text-rose-700'
                        : done
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                          : current
                            ? 'border-[#00BAF2] bg-sky-50 text-[#002E7E]'
                            : 'border-slate-200 bg-white text-slate-400',
                    ].join(' ')}
                    aria-hidden
                  >
                    {failed ? '!' : done ? '✓' : ''}
                  </span>
                  <span className={done || current ? 'font-medium' : 'text-slate-500'}>{row.label}</span>
                </li>
              )
            })}
          </ol>
          <div className="mt-4">
            <ProgressBar value={task.progress} />
            <p className="mt-2 text-sm text-slate-700">{statusLineFromTask(task)}</p>
          </div>
        </div>

        <LogsViewer lines={lines} loading={loading} error={error} />

        <div className="rounded-xl border border-slate-200 bg-[#F5F7F9] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#002E7E]">Pull request</p>
          {prUrls.length > 0 ? (
            <>
              <div className="mt-2 space-y-2">
                {prUrls.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="block break-all font-mono text-xs font-medium text-[#00BAF2]"
                  >
                    {url}
                  </a>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-[#002E7E] shadow-sm hover:bg-slate-50"
                  href={latestPrUrl || undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  View Latest PR
                </a>
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                  onClick={() => void refreshTasks()}
                >
                  Re-sync
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500"
                  onClick={() => {
                    alert('Deploy Now will trigger your deployment pipeline (mock).')
                  }}
                >
                  Deploy Now
                </button>
                {/* <button
                  type="button"
                  className="rounded-lg bg-[#00BAF2] px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[#00a8d9]"
                  onClick={() => {
                    if (latestPrUrl) void navigator.clipboard.writeText(latestPrUrl)
                  }}
                >
                  Copy latest link
                </button> */}
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-500">PR links appear when the job completes.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
          <p>
            <span className="text-slate-500">Deployment status:</span>{' '}
            <span className="font-semibold text-[#002E7E]">
              {task.pipelineStatus === 'CLOSED' || task.status === 'completed'
                ? task.pipelineStatus === 'CLOSED'
                  ? 'Deployed (closed)'
                  : 'Deployed'
                : task.status === 'failed'
                  ? 'Failed'
                  : 'Pending deployment…'}
            </span>
          </p>
          {task.status === 'failed' ? (
            <button
              type="button"
              className="rounded-lg bg-[#00BAF2] px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[#00a8d9]"
              onClick={() => void retryTask(task.id)}
            >
              Retry pipeline
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function shortId(id: string): string {
  const compact = id.replace(/[^a-zA-Z0-9]/g, '')
  return compact.slice(0, 10) || id.slice(0, 10)
}
