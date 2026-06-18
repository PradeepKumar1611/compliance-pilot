import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  X,
  Filter,
  Flag,
  Clock,
  FileText,
  BookOpen,
  RefreshCw,
} from 'lucide-react'
import api from '../lib/api'
import { useAuth, useToast } from '../App'
import { cn, getConfidenceBadge, truncate, formatDate } from '../lib/utils'

const DEFAULT_FILTERS = {
  date_from: '',
  date_to: '',
  tier: '',
  flagged_only: false,
  kb_version: '',
}

export default function AuditLog() {
  const { user } = useAuth()
  const showToast = useToast()

  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [perPage] = useState(20)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState(DEFAULT_FILTERS)
  const [selectedLog, setSelectedLog] = useState(null)
  const [showPanel, setShowPanel] = useState(false)
  const [loading, setLoading] = useState(false)
  const [expandedAnswer, setExpandedAnswer] = useState(null)

  const totalPages = Math.max(1, Math.ceil(total / perPage))

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const params = {
        page,
        per_page: perPage,
      }
      if (appliedFilters.date_from) params.date_from = appliedFilters.date_from
      if (appliedFilters.date_to) params.date_to = appliedFilters.date_to
      if (appliedFilters.tier) params.confidence_tier = appliedFilters.tier
      if (appliedFilters.flagged_only) params.flagged_only = true
      if (appliedFilters.kb_version) params.kb_version = appliedFilters.kb_version

      const { data } = await api.get('/audit', { params })
      setLogs(data.items || data.logs || [])
      setTotal(data.total || 0)
    } catch (err) {
      showToast('Failed to load audit logs', 'error')
    } finally {
      setLoading(false)
    }
  }, [page, perPage, appliedFilters, showToast])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  const handleApplyFilters = () => {
    setAppliedFilters({ ...filters })
    setPage(1)
  }

  const handleExportCSV = async () => {
    try {
      const params = {}
      if (appliedFilters.date_from) params.date_from = appliedFilters.date_from
      if (appliedFilters.date_to) params.date_to = appliedFilters.date_to
      if (appliedFilters.tier) params.confidence_tier = appliedFilters.tier
      if (appliedFilters.flagged_only) params.flagged_only = true
      if (appliedFilters.kb_version) params.kb_version = appliedFilters.kb_version

      const response = await api.get('/audit/export/csv', {
        params,
        responseType: 'blob',
      })

      const url = window.URL.createObjectURL(new Blob([response.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `audit_log_${new Date().toISOString().slice(0, 10)}.csv`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      showToast('CSV exported successfully')
    } catch {
      showToast('Failed to export CSV', 'error')
    }
  }

  const closeBtnRef = useRef(null)
  const lastFocusedRef = useRef(null)

  const openPanel = (log) => {
    lastFocusedRef.current = document.activeElement
    setSelectedLog(log)
    setShowPanel(true)
  }

  const closePanel = useCallback(() => {
    setShowPanel(false)
    setTimeout(() => setSelectedLog(null), 300)
    // restore focus to whatever opened the panel
    if (lastFocusedRef.current && lastFocusedRef.current.focus) {
      lastFocusedRef.current.focus()
    }
  }, [])

  // When the panel opens: focus the close button and wire Escape-to-close.
  useEffect(() => {
    if (!showPanel) return
    closeBtnRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showPanel, closePanel])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ivory">Audit Log</h1>
          <p className="mt-1 text-sm text-ivory-dim">
            Complete history of all generated answers
          </p>
        </div>
        <button
          onClick={fetchLogs}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ivory-dim transition-colors hover:text-ivory hover:bg-surface2"
          title="Refresh audit logs"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-end gap-4">
          {/* Date From */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-ivory-dim">From</label>
            <input
              type="date"
              value={filters.date_from}
              onChange={(e) => setFilters({ ...filters, date_from: e.target.value })}
              className="block rounded-lg border border-line bg-obsidian px-3 py-2 text-sm text-ivory placeholder-ivory-dim/60 focus:border-champagne focus:outline-none focus:ring-1 focus:ring-champagne"
            />
          </div>

          {/* Date To */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-ivory-dim">To</label>
            <input
              type="date"
              value={filters.date_to}
              onChange={(e) => setFilters({ ...filters, date_to: e.target.value })}
              className="block rounded-lg border border-line bg-obsidian px-3 py-2 text-sm text-ivory placeholder-ivory-dim/60 focus:border-champagne focus:outline-none focus:ring-1 focus:ring-champagne"
            />
          </div>

          {/* Confidence Tier */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-ivory-dim">Confidence Tier</label>
            <select
              value={filters.tier}
              onChange={(e) => setFilters({ ...filters, tier: e.target.value })}
              className="block rounded-lg border border-line bg-obsidian px-3 py-2 text-sm text-ivory focus:border-champagne focus:outline-none focus:ring-1 focus:ring-champagne"
            >
              <option value="">All</option>
              <option value="auto_fill">Auto-filled</option>
              <option value="needs_review">Needs Review</option>
              <option value="no_answer">No Answer</option>
            </select>
          </div>

          {/* Flagged Only */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-ivory-dim">Flagged Only</label>
            <label className="flex cursor-pointer items-center gap-2">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={filters.flagged_only}
                  onChange={(e) => setFilters({ ...filters, flagged_only: e.target.checked })}
                  className="peer sr-only"
                />
                <div className="h-6 w-11 rounded-full bg-surface2 transition-colors peer-checked:bg-champagne-bright" />
                <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
              </div>
            </label>
          </div>

          {/* KB Version */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-ivory-dim">KB Version</label>
            <input
              type="number"
              value={filters.kb_version}
              onChange={(e) => setFilters({ ...filters, kb_version: e.target.value })}
              placeholder="Any"
              className="block w-20 rounded-lg border border-line bg-obsidian px-3 py-2 text-sm text-ivory placeholder-ivory-dim/60 focus:border-champagne focus:outline-none focus:ring-1 focus:ring-champagne"
            />
          </div>

          {/* Buttons */}
          <button
            onClick={handleApplyFilters}
            className="flex items-center gap-2 rounded-lg bg-champagne px-4 py-2 text-sm font-medium text-ivory transition-colors hover:bg-champagne"
          >
            <Filter className="h-4 w-4" />
            Apply Filters
          </button>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 rounded-lg border border-line bg-obsidian px-4 py-2 text-sm font-medium text-ivory transition-colors hover:border-champagne/40 hover:bg-surface2"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">Time</th>
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">Question</th>
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">Answer</th>
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">Confidence</th>
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">Tier</th>
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">KB Ver</th>
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">Model</th>
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">Lang</th>
              <th className="px-4 py-3 text-left font-medium text-ivory-dim">Flagged</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-ivory-dim">
                  Loading...
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center">
                  <div className="space-y-2">
                    <Clock className="h-8 w-8 text-ivory-dim mx-auto" />
                    <p className="text-sm text-ivory-dim">No audit logs found.</p>
                    {user?.role !== 'admin' && (
                      <p className="text-xs text-ivory-dim">Process a questionnaire to see your answer history here.</p>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              logs.map((log) => {
                const badge = getConfidenceBadge(log.confidence_tier, log.confidence_score)
                return (
                  <tr
                    key={log.id}
                    onClick={() => openPanel(log)}
                    className="cursor-pointer transition-colors hover:bg-white/[0.03]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-ivory-dim">
                      {formatDate(log.timestamp)}
                    </td>
                    <td className="max-w-[200px] px-4 py-3 text-ivory">
                      {truncate(log.question_text, 50)}
                    </td>
                    <td
                      className="max-w-[200px] px-4 py-3 text-ivory cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedAnswer(expandedAnswer === log.id ? null : log.id)
                      }}
                    >
                      {expandedAnswer === log.id ? log.answer_text : truncate(log.answer_text, 50)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium',
                          badge.className
                        )}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ivory-dim">{log.confidence_tier}</td>
                    <td className="px-4 py-3 text-ivory-dim">{log.kb_version_used ?? '-'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ivory-dim">
                      {log.llm_model_used || '-'}
                    </td>
                    <td className="px-4 py-3 text-ivory-dim">{log.original_language || '-'}</td>
                    <td className="px-4 py-3">
                      {log.confidence_tier === 'no_answer' ? (
                        <Flag className="h-4 w-4 text-review" />
                      ) : (
                        <span className="text-ivory-dim">-</span>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-ivory-dim">
          {total} total record{total !== 1 ? 's' : ''}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex items-center gap-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ivory transition-colors hover:border-champagne/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </button>
          <span className="text-sm text-ivory-dim">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex items-center gap-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ivory transition-colors hover:border-champagne/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Backdrop */}
      {showPanel && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          aria-hidden="true"
          onClick={closePanel}
        />
      )}

      {/* Side Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Audit log detail"
        aria-hidden={!showPanel}
        className={cn(
          'fixed inset-y-0 right-0 z-50 w-full max-w-md transform border-l border-line bg-surface shadow-2xl transition-transform duration-300 ease-in-out',
          showPanel ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {selectedLog && (
          <div className="flex h-full flex-col">
            {/* Panel Header */}
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <h3 className="text-lg font-medium text-ivory">Audit Detail</h3>
              <button
                ref={closeBtnRef}
                onClick={closePanel}
                aria-label="Close audit detail"
                className="rounded-lg p-1 text-ivory-dim transition-colors hover:bg-surface2 hover:text-ivory focus:outline-none focus:ring-2 focus:ring-champagne/50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Panel Body */}
            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
              {/* Time */}
              <div className="flex items-start gap-3">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-ivory-dim" />
                <div>
                  <p className="text-xs font-medium text-ivory-dim">Timestamp</p>
                  <p className="text-sm text-ivory">
                    {formatDate(selectedLog.created_at || selectedLog.timestamp)}
                  </p>
                </div>
              </div>

              {/* Question */}
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-ivory-dim" />
                <div>
                  <p className="text-xs font-medium text-ivory-dim">Question</p>
                  <p className="text-sm leading-relaxed text-ivory">{selectedLog.question_text}</p>
                </div>
              </div>

              {/* Answer */}
              <div className="flex items-start gap-3">
                <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-ivory-dim" />
                <div>
                  <p className="text-xs font-medium text-ivory-dim">Answer</p>
                  <p className="text-sm leading-relaxed text-ivory">{selectedLog.answer_text}</p>
                </div>
              </div>

              {/* Confidence */}
              <div>
                <p className="text-xs font-medium text-ivory-dim">Confidence</p>
                <div className="mt-1">
                  {(() => {
                    const badge = getConfidenceBadge(selectedLog.confidence_tier, selectedLog.confidence_score)
                    return (
                      <span
                        className={cn(
                          'inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium',
                          badge.className
                        )}
                      >
                        {badge.label}
                      </span>
                    )
                  })()}
                </div>
              </div>

              {/* Source Citations */}
              {selectedLog.source_citations && (
                <div>
                  <p className="text-xs font-medium text-ivory-dim">Source Citations</p>
                  <ul className="mt-2 space-y-2">
                    {(() => {
                      try {
                        const sources = typeof selectedLog.source_citations === 'string'
                          ? JSON.parse(selectedLog.source_citations)
                          : selectedLog.source_citations
                        if (!Array.isArray(sources)) return null
                        return sources.map((src, i) => (
                          <li
                            key={i}
                            className="rounded-lg border border-line bg-obsidian px-3 py-2 text-sm text-ivory"
                          >
                            {src.source_file ? `${src.source_file} (p.${src.page_number})` : JSON.stringify(src)}
                          </li>
                        ))
                      } catch { return null }
                    })()}
                  </ul>
                </div>
              )}

              {/* Metadata */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-ivory-dim">Metadata</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['Tier', selectedLog.confidence_tier],
                    ['KB Version', selectedLog.kb_version_used],
                    ['Model', selectedLog.llm_model_used],
                    ['Language', selectedLog.original_language],
                    ['Translated', selectedLog.was_translated ? 'Yes' : 'No'],
                    ['Job ID', selectedLog.processing_job_id],
                  ].map(
                    ([label, value]) =>
                      value !== undefined &&
                      value !== null && (
                        <div
                          key={label}
                          className="rounded-lg border border-line bg-obsidian px-3 py-2"
                        >
                          <p className="text-xs text-ivory-dim">{label}</p>
                          <p className="text-sm text-ivory">{String(value)}</p>
                        </div>
                      )
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Overlay */}
      {showPanel && (
        <div
          onClick={closePanel}
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity"
        />
      )}
    </div>
  )
}
