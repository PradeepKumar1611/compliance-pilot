import { useState, useEffect } from 'react'
import {
  Database,
  FileCheck,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Activity,
  Clock,
  BarChart3,
  RefreshCw,
  MessageSquare,
  Shield,
  Cpu,
  Layers,
  XCircle,
} from 'lucide-react'
import api from '../lib/api'
import { useToast } from '../App'
import { cn, getConfidenceBadge, truncate, formatDate } from '../lib/utils'

function StatCard({ icon: Icon, label, value, loading, color = 'blue' }) {
  const colors = {
    blue: 'bg-champagne/10 border-champagne/20 text-champagne',
    green: 'bg-approved/10 border-approved/20 text-approved',
    yellow: 'bg-review/10 border-review/20 text-review',
    red: 'bg-flag/10 border-flag/20 text-flag',
    purple: 'bg-champagne/10 border-champagne/20 text-champagne',
  }
  return (
    <div className="group relative p-5 rounded-xl bg-surface border border-line transition-all duration-300 hover:border-champagne/30 hover:shadow-lg hover:shadow-champagne/5">
      <div className="flex items-start justify-between">
        <div>
          {loading ? (
            <div className="h-8 w-16 bg-surface2/60 rounded animate-pulse mb-1" />
          ) : (
            <p className="font-display text-3xl font-medium text-ivory tracking-tight">{value ?? '-'}</p>
          )}
          <p className="text-sm text-ivory-dim mt-1">{label}</p>
        </div>
        <div className={cn('p-2.5 rounded-lg border', colors[color])}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  )
}

function ConfidenceBar({ autoFill, needsReview, noAnswer }) {
  const total = autoFill + needsReview + noAnswer
  if (total === 0) return null
  const pctAuto = Math.round((autoFill / total) * 100)
  const pctReview = Math.round((needsReview / total) * 100)
  const pctNo = 100 - pctAuto - pctReview

  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-surface2">
        {pctAuto > 0 && <div className="bg-approved transition-all" style={{ width: `${pctAuto}%` }} title={`Auto-fill: ${pctAuto}%`} />}
        {pctReview > 0 && <div className="bg-review transition-all" style={{ width: `${pctReview}%` }} title={`Needs review: ${pctReview}%`} />}
        {pctNo > 0 && <div className="bg-flag transition-all" style={{ width: `${pctNo}%` }} title={`No answer: ${pctNo}%`} />}
      </div>
      <div className="flex justify-between text-[11px]">
        <span className="text-approved">{autoFill} auto-fill ({pctAuto}%)</span>
        <span className="text-review">{needsReview} review ({pctReview}%)</span>
        <span className="text-flag">{noAnswer} no answer ({pctNo}%)</span>
      </div>
    </div>
  )
}

function ProgressBar({ percent }) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)))
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Progress: ${clamped}%`}
      className="w-full h-1.5 bg-surface2 rounded-full overflow-hidden"
    >
      <div className="h-full bg-champagne rounded-full transition-all duration-500 ease-out" style={{ width: `${clamped}%` }} />
    </div>
  )
}

export default function Dashboard() {
  const showToast = useToast()

  const [stats, setStats] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [activeJobs, setActiveJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [auditEntries, setAuditEntries] = useState([])
  const [auditLoading, setAuditLoading] = useState(true)

  const fetchAll = async () => {
    setStatsLoading(true)
    setJobsLoading(true)
    setAuditLoading(true)
    const [statsRes, jobsRes, auditRes] = await Promise.allSettled([
      api.get('/dashboard/stats'),
      api.get('/dashboard/active-jobs'),
      api.get('/dashboard/recent-audit'),
    ])
    if (statsRes.status === 'fulfilled') setStats(statsRes.value.data)
    if (jobsRes.status === 'fulfilled') setActiveJobs(Array.isArray(jobsRes.value.data) ? jobsRes.value.data : [])
    if (auditRes.status === 'fulfilled') setAuditEntries(Array.isArray(auditRes.value.data) ? auditRes.value.data : [])
    setStatsLoading(false)
    setJobsLoading(false)
    setAuditLoading(false)

    // Surface partial failures instead of silently showing empty data.
    const failed = [statsRes, jobsRes, auditRes].filter((r) => r.status === 'rejected')
    if (failed.length) {
      showToast('Some dashboard data could not be loaded — showing what we have.', 'error')
    }
  }

  useEffect(() => { fetchAll() }, [])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ivory tracking-tight">Dashboard</h1>
          <p className="text-sm text-ivory-dim mt-1">Overview of your compliance operations</p>
        </div>
        <div className="flex items-center gap-3">
          {stats && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-champagne/10 text-champagne border border-champagne/20">
              <Layers className="w-3 h-3" />
              {stats.kb_version_name}
            </span>
          )}
          <button
            onClick={fetchAll}
            disabled={statsLoading}
            className="p-2 rounded-lg text-ivory-dim hover:text-ivory hover:bg-surface2 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn('w-4 h-4', statsLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Primary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Database} label="KB Documents (Active)" value={stats?.total_kb_docs} loading={statsLoading} color="blue" />
        <StatCard icon={FileCheck} label="Questionnaires Processed" value={stats?.total_questionnaires} loading={statsLoading} color="purple" />
        <StatCard icon={CheckCircle} label="Auto-filled Today" value={stats?.auto_filled_today} loading={statsLoading} color="green" />
        <StatCard icon={AlertTriangle} label="Flagged Today" value={stats?.flagged_today} loading={statsLoading} color="yellow" />
      </div>

      {/* Secondary Stats Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard icon={MessageSquare} label="Total Answers Generated" value={stats?.total_answers} loading={statsLoading} color="blue" />
        <StatCard icon={Layers} label="KB Versions" value={stats?.total_versions} loading={statsLoading} color="purple" />
        <StatCard icon={Cpu} label="Embedding Model" value={stats?.kb_embed_model} loading={statsLoading} color="green" />
      </div>

      {/* KB Health + Confidence Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* KB Health */}
        <div className="p-5 rounded-xl bg-surface border border-line">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-5 h-5 text-champagne" />
            <h2 className="text-sm font-medium text-ivory">Knowledge Base Health</h2>
            <span className="text-xs text-ivory-dim ml-auto">v{stats?.kb_version}</span>
          </div>
          {stats ? (
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 rounded-lg bg-approved/5 border border-approved/20">
                <p className="text-xl font-semibold text-approved">{stats.kb_ready}</p>
                <p className="text-[11px] text-approved/70">Ready</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-review/5 border border-review/20">
                <p className="text-xl font-semibold text-review">{stats.kb_processing}</p>
                <p className="text-[11px] text-review/70">Processing</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-flag/5 border border-flag/20">
                <p className="text-xl font-semibold text-flag">{stats.kb_failed}</p>
                <p className="text-[11px] text-flag/70">Failed</p>
              </div>
            </div>
          ) : (
            <div className="h-20 flex items-center justify-center"><Loader2 className="w-5 h-5 text-ivory-dim animate-spin" /></div>
          )}
        </div>

        {/* Confidence Distribution */}
        <div className="p-5 rounded-xl bg-surface border border-line">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-5 h-5 text-champagne" />
            <h2 className="text-sm font-medium text-ivory">Answer Confidence Distribution</h2>
            <span className="text-xs text-ivory-dim ml-auto">all time</span>
          </div>
          {stats ? (
            <ConfidenceBar
              autoFill={stats.confidence_auto_fill || 0}
              needsReview={stats.confidence_needs_review || 0}
              noAnswer={stats.confidence_no_answer || 0}
            />
          ) : (
            <div className="h-20 flex items-center justify-center"><Loader2 className="w-5 h-5 text-ivory-dim animate-spin" /></div>
          )}
        </div>
      </div>

      {/* Active Jobs */}
      <div className="p-5 rounded-xl bg-surface border border-line">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-champagne" />
          <h2 className="text-sm font-medium text-ivory">Active Jobs</h2>
        </div>
        {jobsLoading ? (
          <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 text-ivory-dim animate-spin" /></div>
        ) : activeJobs.length === 0 ? (
          <div className="text-center py-6">
            <Activity className="w-7 h-7 text-ivory-dim mx-auto mb-2" />
            <p className="text-xs text-ivory-dim">No active jobs</p>
          </div>
        ) : (
          <div className="space-y-3">
            {activeJobs.map((job, idx) => {
              const percent = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0
              return (
                <div key={job.id || idx} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-ivory font-medium truncate mr-3">{job.filename}</span>
                    <span className="text-xs text-ivory-dim flex-shrink-0">{percent}%</span>
                  </div>
                  <ProgressBar percent={percent} />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="p-5 rounded-xl bg-surface border border-line">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-champagne" />
          <h2 className="text-sm font-medium text-ivory">Recent Activity</h2>
          <span className="text-xs text-ivory-dim ml-auto">last 10</span>
        </div>
        {auditLoading ? (
          <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 text-ivory-dim animate-spin" /></div>
        ) : auditEntries.length === 0 ? (
          <div className="text-center py-6">
            <Clock className="w-7 h-7 text-ivory-dim mx-auto mb-2" />
            <p className="text-xs text-ivory-dim">No recent activity</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left py-2.5 px-3 text-xs font-medium text-ivory-dim uppercase tracking-wider">Question</th>
                  <th className="text-left py-2.5 px-3 text-xs font-medium text-ivory-dim uppercase tracking-wider">Answer</th>
                  <th className="text-left py-2.5 px-3 text-xs font-medium text-ivory-dim uppercase tracking-wider">Confidence</th>
                  <th className="text-left py-2.5 px-3 text-xs font-medium text-ivory-dim uppercase tracking-wider">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {auditEntries.map((entry, idx) => {
                  const badge = getConfidenceBadge(entry.confidence_tier, entry.confidence_score)
                  return (
                    <tr key={entry.id || idx} className="hover:bg-surface2/30 transition-colors">
                      <td className="py-2.5 px-3 text-ivory" title={entry.question_text}>{truncate(entry.question_text, 50)}</td>
                      <td className="py-2.5 px-3 text-ivory-dim" title={entry.answer_text}>{truncate(entry.answer_text, 50)}</td>
                      <td className="py-2.5 px-3">
                        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border', badge.className)}>{badge.label}</span>
                      </td>
                      <td className="py-2.5 px-3 text-ivory-dim whitespace-nowrap">{formatDate(entry.created_at || entry.timestamp)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
