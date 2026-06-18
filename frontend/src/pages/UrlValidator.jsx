import { useState, useEffect } from 'react'
import { Search, Loader2, AlertTriangle, CheckCircle2, FileText, ExternalLink, XCircle } from 'lucide-react'
import api from '../lib/api'
import { useToast } from '../App'
import { cn } from '../lib/utils'

export default function UrlValidator() {
  const showToast = useToast()
  const [version, setVersion] = useState(null)
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState(null)
  const [polling, setPolling] = useState(false)

  // Fetch current version and load versions list
  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await api.get('/kb/versions')
        setVersions(data.versions || [])
        if (data.active_version) setVersion(data.active_version)
      } catch {
        try {
          const { data } = await api.get('/kb/version')
          setVersion(data.current_version ?? 1)
        } catch { /* ignore */ }
      }

      // Load last validation results on mount
      try {
        const { data } = await api.get('/kb/url-validation-status')
        if (data.checked > 0) {
          setStatus(data)
          if (data.running) setPolling(true)
        }
      } catch { /* ignore */ }
    }
    load()
  }, [])

  // Poll status when running
  useEffect(() => {
    if (!polling) return
    const poll = async () => {
      try {
        const { data } = await api.get('/kb/url-validation-status')
        setStatus(data)
        if (!data.running) {
          setPolling(false)
        }
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [polling])

  const handleStart = async () => {
    if (!version) return
    setLoading(true)
    setStatus(null)
    try {
      const { data } = await api.post(`/kb/validate-urls?version=${version}`)
      showToast(data.message, 'success')
      setPolling(true)
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to start validation', 'error')
    } finally {
      setLoading(false)
    }
  }

  const progress = status?.total ? Math.round((status.checked / status.total) * 100) : 0
  const isRunning = status?.running || polling
  const isDone = status && !status.running && status.checked > 0
  const downCount = status?.down_urls?.length || 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-ivory">URL Validator</h1>
        <p className="mt-1 text-sm text-ivory-dim">
          Check if all URLs in the knowledge base are still accessible
        </p>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-line bg-surface p-6 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="space-y-1">
            <label className="text-xs font-medium text-ivory-dim">KB Version</label>
            {versions.length > 0 && (
              <select
                value={version || ''}
                onChange={(e) => setVersion(Number(e.target.value))}
                className="block rounded-lg border border-line bg-obsidian px-3 py-2 text-sm text-ivory focus:border-champagne focus:outline-none"
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.is_active ? '★ ' : ''}v{v.version} — {v.name} ({v.doc_count} docs)
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="pt-5">
            <button
              onClick={handleStart}
              disabled={loading || isRunning || !version}
              className="flex items-center gap-2 rounded-lg bg-champagne px-5 py-2 text-sm font-medium text-ivory transition-colors hover:bg-champagne disabled:opacity-50"
            >
              {loading || isRunning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              {isRunning ? 'Checking...' : 'Check URLs'}
            </button>
          </div>
        </div>

        {/* Progress */}
        {isRunning && status && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-ivory-dim">
              <span>Checking URLs...</span>
              <span>{status.checked} / {status.total} ({progress}%)</span>
            </div>
            <div className="w-full bg-surface2 rounded-full h-2">
              <div
                className="bg-champagne h-2 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            {downCount > 0 && (
              <p className="text-xs text-flag">{downCount} down URL{downCount > 1 ? 's' : ''} found so far</p>
            )}
          </div>
        )}

        {/* Summary when done */}
        {isDone && (
          <div className={cn(
            'flex items-center gap-3 rounded-lg p-3 border',
            downCount > 0
              ? 'border-flag/30 bg-flag/10'
              : 'border-approved/30 bg-approved/10'
          )}>
            {downCount > 0 ? (
              <>
                <AlertTriangle className="w-5 h-5 text-flag flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-flag">
                    {downCount} URL{downCount > 1 ? 's' : ''} down or unreachable
                  </p>
                  <p className="text-xs text-flag/70">
                    Checked {status.checked} URLs from version {version}
                  </p>
                </div>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-5 h-5 text-approved flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-300">All URLs are accessible</p>
                  <p className="text-xs text-approved/70">
                    Checked {status.checked} URLs from version {version}
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Down URLs Results */}
      {isDone && downCount > 0 && (
        <div className="rounded-xl border border-line bg-surface overflow-hidden">
          <div className="p-4 border-b border-line">
            <h2 className="text-sm font-medium text-flag">
              Down / Unreachable URLs ({downCount})
            </h2>
          </div>

          <div className="divide-y divide-line">
            {status.down_urls.map((item, i) => (
              <div key={i} className="p-4 hover:bg-surface2/30 transition-colors">
                <div className="flex items-start gap-3">
                  <XCircle className="w-4 h-4 text-flag mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-champagne hover:text-champagne-bright truncate block max-w-2xl"
                      >
                        {item.url}
                      </a>
                      <ExternalLink className="w-3 h-3 text-champagne flex-shrink-0" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-flag/20 text-flag border border-flag/30">
                        {typeof item.status === 'number' ? `HTTP ${item.status}` : item.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {item.sources.map((src, j) => (
                        <span
                          key={j}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface2/60 text-[10px] text-ivory-dim border border-line/50"
                        >
                          <FileText className="w-2.5 h-2.5" />
                          {src}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
