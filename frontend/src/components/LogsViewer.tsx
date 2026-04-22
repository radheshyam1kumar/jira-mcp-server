import { useEffect, useRef } from 'react'

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
            <div key={`${idx}-${line}`} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
