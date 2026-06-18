import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function getConfidenceBadge(tier, score) {
  const s = score !== undefined ? ` (${(score * 100).toFixed(0)}%)` : ''
  switch (tier) {
    case 'auto_fill':
      return { label: `Auto-filled${s}`, className: 'bg-green-500/20 text-green-400 border-green-500/30' }
    case 'needs_review':
      return { label: `Needs Review${s}`, className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' }
    case 'no_answer':
      return { label: `No Answer${s}`, className: 'bg-red-500/20 text-red-400 border-red-500/30' }
    default:
      return { label: tier || 'Unknown', className: 'bg-slate-500/20 text-slate-400 border-slate-500/30' }
  }
}

export function truncate(str, len = 80) {
  if (!str) return ''
  return str.length > len ? str.slice(0, len) + '...' : str
}

export function formatDate(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}
