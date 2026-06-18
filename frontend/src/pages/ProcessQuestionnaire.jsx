import { useState, useEffect, useRef, useCallback } from 'react'
import {
  FileUp,
  CheckCircle2,
  Circle,
  Loader2,
  Download,
  RefreshCw,
  AlertTriangle,
  FileText,
  X,
  Clock,
} from 'lucide-react'
import api from '../lib/api'
import { subscribeJob } from '../lib/jobStream'
import { useAuth, useToast } from '../App'
import { cn, getConfidenceBadge, truncate, formatDate } from '../lib/utils'

const STEPS = [
  'Extracting questions...',
  'Searching knowledge base...',
  'Filling answers...',
  'Generating document...',
]

function StepIndicator({ steps, currentStep, isDone, isFailed }) {
  return (
    <div className="space-y-3">
      {steps.map((label, i) => {
        const completed = isDone || i < currentStep
        const active = !isDone && !isFailed && i === currentStep
        return (
          <div key={i} className="flex items-center gap-3">
            {completed ? (
              <CheckCircle2 className="h-5 w-5 text-approved shrink-0" />
            ) : active ? (
              <Loader2 className="h-5 w-5 text-champagne animate-spin shrink-0" />
            ) : (
              <Circle className="h-5 w-5 text-ivory-dim shrink-0" />
            )}
            <span
              className={cn(
                'text-sm transition-colors',
                completed && 'text-approved',
                active && 'text-champagne',
                !completed && !active && 'text-ivory-dim'
              )}
            >
              {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default function ProcessQuestionnaire() {
  const { user } = useAuth()
  const showToast = useToast()

  const [currentFile, setCurrentFile] = useState(null)
  const [jobId, setJobId] = useState(null)
  const [jobStatus, setJobStatus] = useState(null)
  const [results, setResults] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadResponse, setUploadResponse] = useState(null)
  const [previousJobs, setPreviousJobs] = useState([])

  const fileInputRef = useRef(null)
  const pollRef = useRef(null)

  // Fetch previous jobs on mount
  useEffect(() => {
    fetchPreviousJobs()
  }, [])

  const fetchPreviousJobs = async () => {
    try {
      const { data } = await api.get('/questionnaire/jobs')
      setPreviousJobs(Array.isArray(data) ? data : [])
    } catch { /* ignore */ }
  }

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      pollRef.current() // unsubscribe fn from subscribeJob
      pollRef.current = null
    }
  }, [])

  // Live job status via SSE (auto-falls back to polling).
  useEffect(() => {
    if (!jobId) return
    clearPoll()

    pollRef.current = subscribeJob(
      jobId,
      async (data) => {
        setJobStatus(data)
        if (data.status === 'done') {
          try {
            const res = await api.get(`/questionnaire/jobs/${jobId}/results`)
            setResults(res.data)
          } catch {
            showToast('Failed to load results', 'error')
          }
          fetchPreviousJobs()
        } else if (data.status === 'failed' || data.status === 'cancelled') {
          fetchPreviousJobs()
        }
      },
      () => showToast('Lost connection to job', 'error')
    )

    return clearPoll
  }, [jobId, clearPoll, showToast])

  const handleUpload = async (file) => {
    if (!file) return
    setCurrentFile(file)
    setIsUploading(true)
    setJobStatus(null)
    setResults(null)
    setUploadResponse(null)

    try {
      const formData = new FormData()
      formData.append('file', file)
      const { data } = await api.post('/questionnaire/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setUploadResponse(data)
      setJobId(data.job_id)
      showToast('Questionnaire uploaded, processing started')
    } catch (err) {
      showToast(err.response?.data?.detail || 'Upload failed', 'error')
      setCurrentFile(null)
    } finally {
      setIsUploading(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleUpload(file)
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    setDragOver(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    setDragOver(false)
  }

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (file) handleUpload(file)
  }

  const handleReset = () => {
    clearPoll()
    setCurrentFile(null)
    setJobId(null)
    setJobStatus(null)
    setResults(null)
    setIsUploading(false)
    setUploadResponse(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Map processing progress to step index based on processed_questions ratio
  const currentStep = jobStatus
    ? jobStatus.status === 'queued'
      ? 0
      : jobStatus.status === 'processing'
        ? jobStatus.total_questions && jobStatus.processed_questions
          ? jobStatus.processed_questions >= jobStatus.total_questions ? 3
            : jobStatus.processed_questions > 0 ? 1
            : 0
          : 0
        : jobStatus.status === 'done'
          ? 4
          : 0
    : 0

  const progress =
    jobStatus && jobStatus.total_questions
      ? Math.round((jobStatus.processed_questions / jobStatus.total_questions) * 100)
      : 0

  const isDone = jobStatus?.status === 'done'
  const isFailed = jobStatus?.status === 'failed' || jobStatus?.status === 'cancelled'
  const isProcessing = jobStatus?.status === 'processing' || jobStatus?.status === 'queued'

  const handleCancel = async () => {
    if (!jobId) return
    try {
      await api.post(`/questionnaire/jobs/${jobId}/cancel`)
      showToast('Stopping job...', 'success')
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to stop job', 'error')
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-ivory">Process Questionnaire</h1>
        <p className="mt-1 text-sm text-ivory-dim">
          Upload and auto-fill compliance questionnaires
        </p>
      </div>

      {/* Upload / Processing Card */}
      {!currentFile ? (
        /* Drag & Drop Zone */
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            'relative cursor-pointer rounded-xl border-2 border-dashed p-16 text-center transition-all duration-300',
            dragOver
              ? 'border-champagne bg-champagne/10 shadow-[0_0_30px_rgba(59,130,246,0.15)]'
              : 'border-line bg-surface hover:border-champagne/40 hover:shadow-[0_0_20px_rgba(59,130,246,0.08)]'
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.xlsx,.txt,.json"
            onChange={handleFileSelect}
            className="hidden"
          />
          <FileUp
            className={cn(
              'mx-auto h-14 w-14 transition-colors',
              dragOver ? 'text-champagne' : 'text-ivory-dim'
            )}
          />
          <h3 className="mt-4 text-lg font-medium text-ivory">Drop your questionnaire here</h3>
          <p className="mt-1 text-sm text-ivory-dim">PDF, DOCX, XLSX, TXT, or JSON</p>
          <p className="mt-2 text-xs text-ivory-dim">or click to browse</p>
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-surface p-6 space-y-6">
          {/* File info */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-champagne" />
              <span className="text-sm font-medium text-ivory">{currentFile.name}</span>
              {uploadResponse && (
                <>
                  <span className="rounded-full bg-champagne/20 px-2.5 py-0.5 text-xs font-medium text-champagne border border-champagne/30">
                    {uploadResponse.format?.toUpperCase()}
                  </span>
                  <span className="text-sm text-ivory-dim">
                    {uploadResponse.question_count} questions detected
                  </span>
                </>
              )}
            </div>
            {isProcessing && (
              <button
                onClick={handleCancel}
                className="flex items-center gap-2 rounded-lg bg-flag/20 border border-flag/30 px-3 py-1.5 text-sm text-flag transition-colors hover:bg-flag/30"
              >
                <X className="h-4 w-4" />
                Stop
              </button>
            )}
            {(isDone || isFailed) && (
              <button
                onClick={handleReset}
                className="flex items-center gap-2 rounded-lg bg-surface2 px-3 py-1.5 text-sm text-ivory transition-colors hover:bg-surface2"
              >
                <RefreshCw className="h-4 w-4" />
                Process Another
              </button>
            )}
          </div>

          {/* Upload spinner */}
          {isUploading && (
            <div className="flex items-center gap-3 text-champagne">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Uploading...</span>
            </div>
          )}

          {/* Step progress */}
          {jobStatus && !isFailed && (
            <div className="space-y-4">
              <StepIndicator
                steps={STEPS}
                currentStep={currentStep}
                isDone={isDone}
                isFailed={isFailed}
              />

              {/* Progress bar */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-ivory-dim">
                  <span>Progress</span>
                  <span>{progress}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Questionnaire processing progress"
                  className="h-2 w-full overflow-hidden rounded-full bg-surface2"
                >
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      isDone ? 'bg-approved' : 'bg-champagne'
                    )}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Failed */}
          {isFailed && (
            <div className="flex items-start gap-3 rounded-lg border border-flag/30 bg-flag/10 p-4">
              <AlertTriangle className="h-5 w-5 shrink-0 text-flag" />
              <div>
                <p className="text-sm font-medium text-flag">Processing Failed</p>
                <p className="mt-1 text-sm text-flag/70">
                  {jobStatus.error_message || 'An unexpected error occurred. Please try again.'}
                </p>
              </div>
            </div>
          )}

          {/* Done: Download + Results */}
          {isDone && (
            <div className="space-y-6">
              <button
                onClick={async () => {
                  try {
                    const resp = await api.get(`/questionnaire/jobs/${jobId}/download`, { responseType: 'blob' })
                    const url = window.URL.createObjectURL(new Blob([resp.data]))
                    const link = document.createElement('a')
                    link.href = url
                    // Extract filename from Content-Disposition header (server sends correct extension)
                    const disposition = resp.headers['content-disposition'] || ''
                    const match = disposition.match(/filename\*?=(?:utf-8''|")(.+?)(?:"|$)/i)
                    const name = match ? decodeURIComponent(match[1]) : (currentFile?.name ? `filled_${currentFile.name}` : 'filled_document')
                    link.setAttribute('download', name)
                    document.body.appendChild(link)
                    link.click()
                    link.remove()
                    window.URL.revokeObjectURL(url)
                  } catch {
                    showToast('Failed to download document', 'error')
                  }
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-approved px-5 py-2.5 text-sm font-medium text-ivory transition-colors hover:bg-approved shadow-[0_0_20px_rgba(34,197,94,0.2)]"
              >
                <Download className="h-4 w-4" />
                Download Filled Document
              </button>

              {/* Results table */}
              {results && results.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-ivory">
                    Summary ({results.length} Q&A pairs)
                  </h3>
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-line bg-obsidian">
                          <th className="px-4 py-3 text-left font-medium text-ivory-dim">#</th>
                          <th className="px-4 py-3 text-left font-medium text-ivory-dim">
                            Question
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-ivory-dim">Answer</th>
                          <th className="px-4 py-3 text-left font-medium text-ivory-dim">
                            Confidence
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {results.map((r, i) => {
                          const badge = getConfidenceBadge(r.confidence_tier, r.confidence_score)
                          return (
                            <tr
                              key={i}
                              className="transition-colors hover:bg-white/[0.02]"
                            >
                              <td className="px-4 py-3 text-ivory-dim">{i + 1}</td>
                              <td className="px-4 py-3 text-ivory">
                                {truncate(r.question_text, 60)}
                              </td>
                              <td className="px-4 py-3 text-ivory">
                                {truncate(r.answer_text, 60)}
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
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Previous Jobs */}
      {previousJobs.length > 0 && (
        <div className={cn(
          'rounded-xl overflow-hidden',
          'bg-surface border border-line',
          'transition-all duration-300',
          'hover:border-champagne/20 hover:shadow-lg hover:shadow-champagne/5'
        )}>
          <div className="flex items-center gap-2 p-5 border-b border-line">
            <Clock className="w-5 h-5 text-champagne" />
            <h2 className="text-lg font-medium text-ivory">Previous Jobs</h2>
            <button
              onClick={fetchPreviousJobs}
              className="ml-auto p-1.5 rounded-lg text-ivory-dim hover:text-ivory hover:bg-surface2 transition-colors"
              title="Refresh jobs"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">File</th>
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">Status</th>
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">Progress</th>
                  <th className="text-left py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider">Created</th>
                  <th className="py-3 px-5 text-xs font-medium text-ivory-dim uppercase tracking-wider text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {previousJobs.map((job) => {
                  const statusStyle = {
                    done: 'bg-approved/20 text-approved border-approved/30',
                    failed: 'bg-flag/20 text-flag border-flag/30',
                    cancelled: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
                    processing: 'bg-review/20 text-review border-review/30',
                    queued: 'bg-surface2/70 text-ivory-dim border-line',
                  }
                  return (
                    <tr key={job.id} className="hover:bg-surface2/30 transition-colors">
                      <td className="py-3 px-5">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-ivory-dim flex-shrink-0" />
                          <span className="text-ivory font-medium truncate max-w-xs">{job.filename}</span>
                        </div>
                      </td>
                      <td className="py-3 px-5">
                        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border', statusStyle[job.status] || statusStyle.queued)}>
                          {job.status}
                        </span>
                      </td>
                      <td className="py-3 px-5 text-ivory-dim">
                        {job.processed_questions}/{job.total_questions} questions
                      </td>
                      <td className="py-3 px-5 text-ivory-dim whitespace-nowrap">
                        {formatDate(job.created_at)}
                      </td>
                      <td className="py-3 px-5 text-right">
                        {job.status === 'done' && (
                          <button
                            onClick={async () => {
                              try {
                                const resp = await api.get(`/questionnaire/jobs/${job.id}/download`, { responseType: 'blob' })
                                const url = window.URL.createObjectURL(new Blob([resp.data]))
                                const link = document.createElement('a')
                                link.href = url
                                const disp = resp.headers['content-disposition'] || ''
                                const m = disp.match(/filename\*?=(?:utf-8''|")(.+?)(?:"|$)/i)
                                link.setAttribute('download', m ? decodeURIComponent(m[1]) : `filled_${job.filename}`)
                                document.body.appendChild(link)
                                link.click()
                                link.remove()
                                window.URL.revokeObjectURL(url)
                              } catch {
                                showToast('Failed to download', 'error')
                              }
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-approved/80 px-3 py-1.5 text-xs font-medium text-ivory transition-colors hover:bg-approved"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Download
                          </button>
                        )}
                        {job.status === 'failed' && (
                          <span className="text-xs text-flag" title={job.error_message}>
                            {truncate(job.error_message || 'Error', 30)}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
