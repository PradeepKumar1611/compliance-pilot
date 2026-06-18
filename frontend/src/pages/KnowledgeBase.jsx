import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Upload,
  Loader2,
  Trash2,
  FileText,
  Plus,
  HardDrive,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  StopCircle,
  X,
  Download,
  UploadCloud,
  Pencil,
  Star,
  Check,
  Search,
} from 'lucide-react'
import api from '../lib/api'
import { useToast } from '../App'
import { cn, formatDate } from '../lib/utils'

function StatusBadge({ status, errorMessage }) {
  const config = {
    processing: { className: 'bg-review/20 text-review border-review/30', icon: Clock },
    ready: { className: 'bg-approved/20 text-approved border-approved/30', icon: CheckCircle2 },
    failed: { className: 'bg-flag/20 text-flag border-flag/30', icon: XCircle },
  }

  const { className, icon: Icon } = config[status] || config.processing

  return (
    <span
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', className)}
      title={status === 'failed' && errorMessage ? errorMessage : undefined}
    >
      <Icon className="w-3 h-3" />
      {status}
    </span>
  )
}

export default function KnowledgeBase() {
  const showToast = useToast()
  const fileInputRef = useRef(null)

  const [version, setVersion] = useState(null)
  const [versions, setVersions] = useState([])
  const [versionLoading, setVersionLoading] = useState(true)
  const [renamingVersion, setRenamingVersion] = useState(null)
  const [renameText, setRenameText] = useState('')
  const [creatingVersion, setCreatingVersion] = useState(false)
  const [documents, setDocuments] = useState([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [isDragging, setIsDragging] = useState(false)
  const [isQuestionnaire, setIsQuestionnaire] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [statusFilter, setStatusFilter] = useState(null) // null = all, "failed" = only failed
  const [searchQuery, setSearchQuery] = useState('')
  const [searchDebounce, setSearchDebounce] = useState('')
  const [reingesting, setReingesting] = useState(false)
  const [ingestionStatus, setIngestionStatus] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [backups, setBackups] = useState([])
  const [showBackups, setShowBackups] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [docPage, setDocPage] = useState(1)
  const docsPerPage = 20
  const [totalDocs, setTotalDocs] = useState(0)
  const [readyCount, setReadyCount] = useState(0)
  const [processingCount, setProcessingCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState([])

  const fetchVersion = useCallback(async () => {
    try {
      const res = await api.get('/kb/versions')
      const data = res.data
      setVersions(data.versions || [])
      if (data.active_version && (!version || !data.versions.some(v => v.version === version))) {
        setVersion(data.active_version)
      }
    } catch {
      // Fallback to old endpoint
      try {
        const res = await api.get('/kb/version')
        setVersion(res.data.current_version ?? null)
      } catch { /* ignore */ }
    } finally {
      setVersionLoading(false)
    }
  }, [])

  const fetchDocuments = useCallback(async (pg = docPage, silent = false) => {
    if (!silent) setDocsLoading(true)
    if (silent) setRefreshing(true)
    try {
      const params = { page: pg, per_page: docsPerPage }
      if (version) params.version = version
      if (statusFilter) params.status = statusFilter
      if (searchDebounce) params.search = searchDebounce
      const res = await api.get('/kb/documents', { params })
      const data = res.data
      setDocuments(data.items || [])
      setTotalDocs(data.total || 0)
      setReadyCount(data.ready_count || 0)
      setProcessingCount(data.processing_count || 0)
      setFailedCount(data.failed_count || 0)
    } catch (err) {
      if (!silent) showToast('Failed to load documents', 'error')
    } finally {
      setDocsLoading(false)
      setRefreshing(false)
    }
  }, [docPage, docsPerPage, version, statusFilter, searchDebounce, showToast])

  // Debounce search input — triggers fetch 300ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounce(searchQuery)
      setDocPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Fetch version on mount, then docs once version is known
  useEffect(() => {
    fetchVersion()
  }, [fetchVersion])

  useEffect(() => {
    if (version != null) fetchDocuments()
  }, [version, fetchDocuments])

  // Poll ingestion status (with backoff + surfaced errors on repeated failure).
  useEffect(() => {
    let timer = null
    let failures = 0
    let stopped = false
    const schedule = (ms) => {
      if (!stopped) timer = setTimeout(poll, ms)
    }
    const poll = async () => {
      try {
        const { data } = await api.get('/kb/ingestion-status')
        failures = 0
        setIngestionStatus(data)
        // Auto-refresh docs when ingestion finishes
        if (ingestionStatus?.running && !data.running) {
          fetchDocuments()
        }
        schedule(3000)
      } catch {
        failures += 1
        if (failures === 3) {
          showToast('Lost connection to ingestion status — retrying…', 'error')
        }
        schedule(Math.min(30000, 3000 * 2 ** failures)) // exponential backoff
      }
    }
    poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [ingestionStatus?.running])

  async function handleCancelIngestion() {
    setCancelling(true)
    try {
      await api.post('/kb/cancel-ingestion')
      showToast('Cancel requested — ingestion will stop after current document', 'success')
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to cancel', 'error')
    } finally {
      setCancelling(false)
    }
  }

  async function handleDeleteVersion(ver) {
    const verInfo = versions.find(v => v.version === ver)
    if (!window.confirm(`Delete "${verInfo?.name || 'Version ' + ver}" and all its documents? This cannot be undone.`)) return
    try {
      const { data } = await api.delete(`/kb/version/${ver}`)
      showToast(data.message, 'success')
      // Switch to active version if we deleted the viewed one
      const active = versions.find(v => v.is_active && v.version !== ver)
      if (version === ver && active) {
        setVersion(active.version)
      }
      fetchVersion()
      fetchDocuments()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to delete version', 'error')
    }
  }

  async function handleBackup() {
    setBackingUp(true)
    try {
      const { data } = await api.post(`/kb/backup/${version}`)
      showToast(data.message, 'success')
      fetchBackups()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Backup failed', 'error')
    } finally {
      setBackingUp(false)
    }
  }

  async function fetchBackups() {
    try {
      const { data } = await api.get('/kb/backups')
      setBackups(data)
    } catch { /* ignore */ }
  }

  async function handleRestore(filename) {
    if (!window.confirm(`Restore from ${filename}? This will replace the existing collection.`)) return
    setRestoring(true)
    try {
      const { data } = await api.post(`/kb/restore/${filename}`)
      showToast(data.message, 'success')
      fetchVersion()
      fetchDocuments()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Restore failed', 'error')
    } finally {
      setRestoring(false)
    }
  }

  async function handleCreateVersion() {
    setCreatingVersion(true)
    try {
      const res = await api.post('/kb/version')
      const newVer = res.data.new_version ?? res.data.version ?? null
      setVersion(newVer)
      showToast('New KB version created', 'success')
      fetchVersion()
    } catch (err) {
      const msg = err.response?.data?.detail || 'Failed to create version'
      showToast(msg, 'error')
    } finally {
      setCreatingVersion(false)
    }
  }

  async function handleActivateVersion(ver) {
    try {
      await api.post(`/kb/versions/${ver}/activate`)
      showToast(`Version ${ver} is now active`, 'success')
      fetchVersion()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to activate', 'error')
    }
  }

  async function handleRenameVersion(ver) {
    if (!renameText.trim()) return
    try {
      await api.put(`/kb/versions/${ver}/name`, { name: renameText.trim() })
      showToast('Version renamed', 'success')
      setRenamingVersion(null)
      fetchVersion()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to rename', 'error')
    }
  }

  async function uploadFile(file) {
    const id = `${file.name}-${Date.now()}`
    setUploadingFiles((prev) => [...prev, { id, name: file.name, progress: 0, status: 'uploading' }])

    const formData = new FormData()
    formData.append('file', file)
    formData.append('is_questionnaire', isQuestionnaire)

    try {
      const resp = await api.post('/kb/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          const percent = Math.round((e.loaded * 100) / (e.total || 1))
          setUploadingFiles((prev) =>
            prev.map((f) => (f.id === id ? { ...f, progress: percent } : f))
          )
        },
      })

      setUploadingFiles((prev) =>
        prev.map((f) => (f.id === id ? { ...f, progress: 100, status: 'done' } : f))
      )
      if (resp.data?.zip) {
        showToast(`ZIP uploaded: ${resp.data.total_files} files extracted and queued`, 'success')
      } else {
        showToast(`Uploaded ${file.name}`, 'success')
      }

      // Remove from upload list after a moment
      setTimeout(() => {
        setUploadingFiles((prev) => prev.filter((f) => f.id !== id))
      }, 2000)

      fetchDocuments()
    } catch (err) {
      const msg = err.response?.data?.detail || `Failed to upload ${file.name}`
      setUploadingFiles((prev) =>
        prev.map((f) => (f.id === id ? { ...f, status: 'error' } : f))
      )
      showToast(msg, 'error')

      setTimeout(() => {
        setUploadingFiles((prev) => prev.filter((f) => f.id !== id))
      }, 4000)
    }
  }

  function handleFiles(files) {
    const accepted = ['.pdf', '.docx', '.xlsx', '.txt', '.json', '.zip']
    const validFiles = Array.from(files).filter((f) =>
      accepted.some((ext) => f.name.toLowerCase().endsWith(ext))
    )

    if (validFiles.length === 0) {
      showToast('Only .pdf, .docx, .xlsx, .txt, .json, and .zip files are accepted', 'error')
      return
    }

    validFiles.forEach(uploadFile)
  }

  function handleDragOver(e) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  function handleDragLeave(e) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (e.dataTransfer.files?.length) {
      handleFiles(e.dataTransfer.files)
    }
  }

  function handleFileInputChange(e) {
    if (e.target.files?.length) {
      handleFiles(e.target.files)
      e.target.value = ''
    }
  }

  async function handleDelete(doc) {
    if (!window.confirm(`Delete "${doc.filename}"? This action cannot be undone.`)) return

    try {
      await api.delete(`/kb/documents/${doc.id}`)
      showToast(`Deleted ${doc.filename}`, 'success')
      fetchDocuments()
    } catch (err) {
      const msg = err.response?.data?.detail || 'Failed to delete document'
      showToast(msg, 'error')
    }
  }

  async function handleRetryFailed() {
    setRetrying(true)
    try {
      const { data } = await api.post(`/kb/retry-failed${version ? `?version=${version}` : ''}`)
      if (data.count > 0) {
        showToast(`Retrying ${data.count} failed documents`, 'success')
      } else {
        showToast('No failed documents to retry', 'warning')
      }
      fetchDocuments()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to retry', 'error')
    } finally {
      setRetrying(false)
    }
  }

  async function handleReingestAll() {
    if (!window.confirm('This will re-ingest all documents into a new KB version with improved embeddings. Continue?')) return
    setReingesting(true)
    try {
      const { data } = await api.post('/kb/reingest-all')
      showToast(`Re-ingesting ${data.count} docs into v${data.new_version}`, 'success')
      setVersion(data.new_version)
      fetchVersion()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to start re-ingestion', 'error')
    } finally {
      setReingesting(false)
    }
  }

  async function handleClearAll() {
    if (!window.confirm('Are you sure you want to DELETE ALL knowledge base documents?\n\nThis will:\n- Remove all uploaded files\n- Delete all embeddings from Qdrant\n- This action CANNOT be undone')) return
    if (!window.confirm('This is irreversible. Type OK to confirm you want to delete everything.')) return

    setClearing(true)
    try {
      const { data } = await api.delete('/kb/clear-all')
      showToast(`Cleared ${data.documents_deleted} documents and ${data.collections_deleted} collections`, 'success')
      setDocuments([])
      setDocPage(1)
      fetchVersion()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to clear knowledge base', 'error')
    } finally {
      setClearing(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalDocs / docsPerPage))

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ivory tracking-tight">Knowledge Base</h1>
          <p className="text-sm text-ivory-dim mt-1">Manage compliance policy documents</p>
        </div>
        <div className="flex items-center gap-3">
          {!versionLoading && versions.length > 0 && (
            <>
              <select
                value={version || ''}
                onChange={(e) => { setVersion(Number(e.target.value)); setDocPage(1) }}
                className="rounded-lg border border-champagne/20 bg-champagne/10 px-3 py-1.5 text-xs font-medium text-champagne focus:outline-none focus:ring-1 focus:ring-champagne/50"
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.is_active ? '★ ' : ''}v{v.version} — {v.name} ({v.doc_count} docs)
                  </option>
                ))}
              </select>
              {/* Rename */}
              {renamingVersion === version ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRenameVersion(version)}
                    className="rounded-lg border border-line bg-obsidian px-2 py-1 text-xs text-ivory w-40 focus:border-champagne focus:outline-none"
                    autoFocus
                  />
                  <button onClick={() => handleRenameVersion(version)} className="p-1 text-approved hover:text-green-300"><Check className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setRenamingVersion(null)} className="p-1 text-ivory-dim hover:text-ivory"><X className="w-3.5 h-3.5" /></button>
                </div>
              ) : (
                <button
                  onClick={() => { setRenamingVersion(version); setRenameText(versions.find(v => v.version === version)?.name || '') }}
                  className="rounded-lg border border-line bg-surface2/50 p-1.5 text-ivory-dim hover:bg-surface2/70 transition-colors"
                  title="Rename version"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              {/* Set Active */}
              {!versions.find(v => v.version === version)?.is_active && (
                <button
                  onClick={() => handleActivateVersion(version)}
                  className="rounded-lg border border-review/20 bg-review/10 p-1.5 text-review hover:bg-review/20 transition-colors"
                  title="Set as active version"
                >
                  <Star className="w-3.5 h-3.5" />
                </button>
              )}
              {/* Backup */}
              <button
                onClick={handleBackup}
                disabled={backingUp}
                className="rounded-lg border border-approved/20 bg-approved/10 p-1.5 text-approved hover:bg-approved/20 transition-colors"
                title="Backup"
              >
                {backingUp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              </button>
              {/* Backups list */}
              <button
                onClick={() => { fetchBackups(); setShowBackups(!showBackups) }}
                className="rounded-lg border border-line bg-surface2/50 p-1.5 text-ivory-dim hover:bg-surface2/70 transition-colors"
                title="Show backups"
              >
                <UploadCloud className="w-3.5 h-3.5" />
              </button>
              {/* Delete (not for active version) */}
              {!versions.find(v => v.version === version)?.is_active && (
                <button
                  onClick={() => handleDeleteVersion(version)}
                  className="rounded-lg border border-flag/20 bg-flag/10 p-1.5 text-flag hover:bg-flag/20 transition-colors"
                  title="Delete version"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          )}
          <button
            onClick={handleCreateVersion}
            disabled={creatingVersion}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium',
              'bg-champagne text-ivory',
              'hover:bg-champagne-bright',
              'focus:outline-none focus:ring-2 focus:ring-champagne/50 focus:ring-offset-2 focus:ring-offset-obsidian',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-all duration-200'
            )}
          >
            {creatingVersion ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Create New Version
          </button>
          {documents.length > 0 && (
            <button
              onClick={handleClearAll}
              disabled={clearing}
              className={cn(
                'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium',
                'bg-flag/10 text-flag border border-flag/30',
                'hover:bg-flag/20',
                'focus:outline-none',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'transition-all duration-200'
              )}
            >
              {clearing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              Clear All KB
            </button>
          )}
        </div>
      </div>

      {/* Backups Panel */}
      {showBackups && (
        <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-ivory">KB Backups</h3>
            <button onClick={() => setShowBackups(false)} className="text-ivory-dim hover:text-ivory">
              <X className="w-4 h-4" />
            </button>
          </div>
          {backups.length === 0 ? (
            <p className="text-xs text-ivory-dim">No backups available. Click the backup icon next to a version to create one.</p>
          ) : (
            <div className="space-y-2">
              {backups.map((b) => (
                <div key={b.name} className="flex items-center justify-between rounded-lg border border-line bg-obsidian px-3 py-2">
                  <div>
                    <p className="text-xs font-medium text-ivory">{b.name}</p>
                    <p className="text-[10px] text-ivory-dim">{b.size_mb} MB — {new Date(b.created_at).toLocaleString()}</p>
                  </div>
                  <button
                    onClick={() => handleRestore(b.name)}
                    disabled={restoring}
                    className="flex items-center gap-1 rounded-lg border border-champagne/20 bg-champagne/10 px-2 py-1 text-xs text-champagne hover:bg-champagne/20 disabled:opacity-50"
                  >
                    {restoring ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />}
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* File upload area */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          'relative cursor-pointer rounded-xl border-2 border-dashed p-10',
          'transition-all duration-300',
          'flex flex-col items-center justify-center text-center',
          isDragging
            ? 'border-champagne bg-champagne/5'
            : 'border-line bg-surface/50 hover:border-champagne/40 hover:bg-surface'
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.xlsx,.txt,.json,.zip"
          onChange={handleFileInputChange}
          className="hidden"
        />
        <div className="p-3 rounded-xl bg-champagne/10 border border-champagne/20 mb-4">
          <Upload className={cn('w-6 h-6 text-champagne', isDragging && 'animate-bounce')} />
        </div>
        <p className="text-sm font-medium text-ivory">Drag & drop files here</p>
        <p className="text-xs text-ivory-dim mt-1">or click to browse</p>
        <p className="text-xs text-ivory-dim mt-2">Accepts .pdf, .docx, .xlsx, .txt, .json, or .zip (bulk upload)</p>
      </div>

      {/* Questionnaire toggle */}
      <div className="flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2">
          <div className="relative">
            <input
              type="checkbox"
              checked={isQuestionnaire}
              onChange={(e) => setIsQuestionnaire(e.target.checked)}
              className="peer sr-only"
            />
            <div className="h-6 w-11 rounded-full bg-surface2 transition-colors peer-checked:bg-amber-600" />
            <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
          </div>
          <span className="text-sm text-ivory-dim">
            This is a previously answered questionnaire
          </span>
        </label>
        {isQuestionnaire && (
          <span className="text-xs text-amber-400/70">
            Q&A pairs will be extracted and stored as approved prior answers
          </span>
        )}
      </div>

      {/* Upload progress */}
      {uploadingFiles.length > 0 && (
        <div className="space-y-3">
          {uploadingFiles.map((file) => (
            <div
              key={file.id}
              className={cn(
                'flex items-center gap-4 p-3 rounded-lg',
                'bg-surface border border-line'
              )}
            >
              <FileText className="w-4 h-4 text-ivory-dim flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ivory truncate">{file.name}</p>
                <div className="mt-1.5 w-full h-1.5 bg-surface2 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-300',
                      file.status === 'error' ? 'bg-flag' : 'bg-champagne'
                    )}
                    style={{ width: `${file.progress}%` }}
                  />
                </div>
              </div>
              <span className="text-xs text-ivory-dim flex-shrink-0">
                {file.status === 'error'
                  ? 'Failed'
                  : file.status === 'done'
                    ? 'Done'
                    : `${file.progress}%`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Documents table */}
      <div
        className={cn(
          'rounded-xl overflow-hidden',
          'bg-surface border border-line',
          'transition-all duration-300',
          'hover:border-champagne/20 hover:shadow-lg hover:shadow-champagne/5'
        )}
      >
        {/* Ingestion Status Panel */}
        {ingestionStatus?.running && (
          <div className="mb-4 rounded-xl border border-champagne/30 bg-champagne/5 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-champagne" />
                <span className="text-sm font-medium text-champagne-bright">Ingestion in progress</span>
              </div>
              <button
                onClick={handleCancelIngestion}
                disabled={cancelling}
                className="flex items-center gap-1.5 rounded-lg border border-flag/30 bg-flag/10 px-3 py-1.5 text-xs font-medium text-flag transition-colors hover:bg-flag/20 disabled:opacity-50"
              >
                {cancelling ? <Loader2 className="w-3 h-3 animate-spin" /> : <StopCircle className="w-3 h-3" />}
                Cancel
              </button>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-ivory-dim">
                <span className="truncate max-w-md">{ingestionStatus.current_doc || 'Starting...'}</span>
                <span>{ingestionStatus.processed} / {ingestionStatus.total}</span>
              </div>
              <div className="w-full bg-surface2 rounded-full h-2">
                <div
                  className="bg-champagne h-2 rounded-full transition-all duration-500"
                  style={{ width: `${ingestionStatus.total ? Math.round((ingestionStatus.processed / ingestionStatus.total) * 100) : 0}%` }}
                />
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 p-5 border-b border-line flex-wrap">
          <HardDrive className="w-5 h-5 text-champagne" />
          <h2 className="text-lg font-medium text-ivory">Uploaded Documents</h2>
          <button
            onClick={() => fetchDocuments(docPage, true)}
            disabled={refreshing}
            className="p-1.5 rounded-lg text-ivory-dim hover:text-ivory hover:bg-surface2 transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          </button>
          <div className="relative ml-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ivory-dim" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents..."
              className="w-52 pl-8 pr-7 py-1.5 rounded-lg bg-surface2 border border-line text-sm text-ivory placeholder-ivory-dim/60 focus:outline-none focus:border-champagne/50 focus:ring-1 focus:ring-champagne/30 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ivory-dim hover:text-ivory"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {!docsLoading && (
            <div className="flex items-center gap-3 ml-auto">
              <button
                onClick={() => { setStatusFilter(statusFilter === 'ready' ? null : 'ready'); setDocPage(1) }}
                className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer transition-colors',
                  statusFilter === 'ready'
                    ? 'bg-approved/40 text-green-300 border-approved/50 ring-1 ring-approved/30'
                    : 'bg-approved/20 text-approved border-approved/30 hover:bg-approved/30'
                )}
              >
                {readyCount} ready {statusFilter === 'ready' ? '✕' : ''}
              </button>
              {processingCount > 0 && (
                <button
                  onClick={() => { setStatusFilter(statusFilter === 'processing' ? null : 'processing'); setDocPage(1) }}
                  className={cn(
                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer transition-colors',
                    statusFilter === 'processing'
                      ? 'bg-review/40 text-review border-review/50 ring-1 ring-review/30'
                      : 'bg-review/20 text-review border-review/30 hover:bg-review/30'
                  )}>
                  {processingCount} processing {statusFilter === 'processing' ? '✕' : ''}
                </button>
              )}
              {failedCount > 0 && (
                <button
                  onClick={() => { setStatusFilter(statusFilter === 'failed' ? null : 'failed'); setDocPage(1) }}
                  className={cn(
                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer transition-colors',
                    statusFilter === 'failed'
                      ? 'bg-flag/40 text-flag border-flag/50 ring-1 ring-flag/30'
                      : 'bg-flag/20 text-flag border-flag/30 hover:bg-flag/30'
                  )}
                >
                  {failedCount} failed {statusFilter === 'failed' ? '✕' : ''}
                </button>
              )}
              {failedCount > 0 && (
                <button
                  onClick={handleRetryFailed}
                  disabled={retrying}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
                    'bg-flag/10 text-flag border border-flag/30',
                    'hover:bg-flag/20 transition-colors',
                    'disabled:opacity-50'
                  )}
                >
                  {retrying ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <XCircle className="w-3 h-3" />
                  )}
                  Retry All Failed
                </button>
              )}
              <button
                onClick={handleReingestAll}
                disabled={reingesting}
                className="flex items-center gap-1.5 rounded-lg border border-champagne/30 bg-champagne/10 px-3 py-1.5 text-xs font-medium text-champagne transition-colors hover:bg-champagne/20 disabled:opacity-50"
              >
                {reingesting ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Re-ingest All{version ? ` → v${version + 1}` : ''}
              </button>
            </div>
          )}
        </div>

        {docsLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-ivory-dim animate-spin" />
          </div>
        ) : documents.length === 0 ? (
          <div className="text-center py-12">
            <FileText className="w-8 h-8 text-ivory-dim mx-auto mb-2" />
            <p className="text-sm text-ivory-dim">No documents uploaded yet</p>
            <p className="text-xs text-ivory-dim mt-1">Upload files above to get started</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">
                    Filename
                  </th>
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">
                    Version
                  </th>
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">
                    Ingested
                  </th>
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">
                    Chunks
                  </th>
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">
                    Status
                  </th>
                  <th className="py-3 px-5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {documents.map((doc) => (
                  <tr key={doc.id} className="hover:bg-surface2/30 transition-colors group">
                    <td className="py-3 px-5">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-ivory-dim flex-shrink-0" />
                        <span className="text-ivory font-medium truncate max-w-xs">
                          {doc.filename}
                        </span>
                        {doc.is_questionnaire && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30">
                            Q&A
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-5 text-ivory-dim">{doc.version ?? '-'}</td>
                    <td className="py-3 px-5 text-ivory-dim whitespace-nowrap">
                      {formatDate(doc.ingested_at || doc.created_at)}
                    </td>
                    <td className="py-3 px-5 text-ivory-dim">{doc.chunk_count ?? '-'}</td>
                    <td className="py-3 px-5">
                      <StatusBadge status={doc.status} errorMessage={doc.error_message} />
                    </td>
                    <td className="py-3 px-5 text-right">
                      <button
                        onClick={() => handleDelete(doc)}
                        className={cn(
                          'p-1.5 rounded-lg',
                          'text-ivory-dim hover:text-flag',
                          'hover:bg-flag/10',
                          'opacity-0 group-hover:opacity-100',
                          'transition-all duration-200'
                        )}
                        title="Delete document"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {totalDocs > docsPerPage && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-line">
                <span className="text-sm text-ivory-dim">
                  {totalDocs} total documents
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDocPage((p) => Math.max(1, p - 1))}
                    disabled={docPage <= 1}
                    className="px-3 py-1.5 rounded-lg border border-line text-sm text-ivory hover:border-champagne/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-ivory-dim">
                    Page {docPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => setDocPage((p) => Math.min(totalPages, p + 1))}
                    disabled={docPage >= totalPages}
                    className="px-3 py-1.5 rounded-lg border border-line text-sm text-ivory hover:border-champagne/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
