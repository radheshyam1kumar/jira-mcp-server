import { useEffect, useRef, type ReactNode } from 'react'

function linkifyBitbucketPrUrls(line: string): ReactNode {
  // Fresh RegExp each call — global `/g` regexes retain `lastIndex` on reuse.
  const re = /https:\/\/bitbucket\.org\/[^/\s]+\/[^/\s]+\/pull-requests\/\d+/g
  const matches = [...line.matchAll(re)]
  if (matches.length === 0) return line

  const out: ReactNode[] = []
  let cursor = 0
  for (const m of matches) {
    const start = m.index ?? 0
    if (start > cursor) {
      out.push(line.slice(cursor, start))
    }
    const href = m[0]
    out.push(
      <a
        key={`${start}-${href}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-[#0052CC] underline underline-offset-2 hover:text-[#0747A6]"
      >
        {href}
      </a>,
    )
    cursor = start + href.length
  }
  if (cursor < line.length) {
    out.push(line.slice(cursor))
  }
  return out
}

const DEFAULT_LOG_ERROR_SUBSTRINGS = ['fail', 'error', 'forbidden'] as const
const DEFAULT_LOG_SUCCESS_SUBSTRINGS = ['success'] as const

function logLineClassName(
  line: string,
  errorSubstrings: readonly string[],
  successSubstrings: readonly string[],
): string {
  const lower = line.toLowerCase()
  if (errorSubstrings.some((s) => lower.includes(s.toLowerCase()))) {
    return 'text-rose-600 font-medium'
  }
  if (successSubstrings.some((s) => lower.includes(s.toLowerCase()))) {
    return 'text-emerald-600 font-medium'
  }
  return 'text-slate-800'
}

export function LogsViewer({
  lines,
  loading,
  error,
}: {
  lines: string[]
  loading: boolean
  error: string | null
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lastLine = lines.length ? lines[lines.length - 1] : ''

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [lines.length, lastLine])

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 bg-[#F5F7F9] px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#002E7E]">Activity logs</p>
        {loading ? (
          <span className="text-[11px] font-medium text-[#00BAF2]">Updating…</span>
        ) : null}
      </div>
      <div
        ref={containerRef}
        className="max-h-56 overflow-y-auto bg-slate-50 px-3 py-2 font-mono text-[12px] leading-relaxed text-slate-800"
      >
        {error ? (
          <p className="text-rose-600">{error}</p>
        ) : lines.length === 0 ? (
          <p className="text-slate-500">No log lines yet.</p>
        ) : (
          lines.map((line, idx) => (
            <div
              key={`${idx}-${line}`}
              className={`whitespace-pre-wrap break-words ${logLineClassName(
                line,
                DEFAULT_LOG_ERROR_SUBSTRINGS,
                DEFAULT_LOG_SUCCESS_SUBSTRINGS,
              )}`}
            >
              {linkifyBitbucketPrUrls(line)}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
