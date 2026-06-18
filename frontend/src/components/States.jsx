import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '../lib/utils'

export function LoadingState({ label = 'Loading…', className }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex flex-col items-center justify-center py-12 text-ivory-dim', className)}
    >
      <Loader2 className="w-6 h-6 animate-spin mb-3" aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function EmptyState({ title = 'Nothing here yet', description, icon: Icon = Inbox, className }) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center py-12 text-center', className)}
    >
      <Icon className="w-8 h-8 text-ivory-dim mb-3" aria-hidden="true" />
      <p className="text-sm font-medium text-ivory">{title}</p>
      {description && <p className="text-xs text-ivory-dim mt-1 max-w-sm">{description}</p>}
    </div>
  )
}

export function ErrorState({ message = 'Something went wrong.', onRetry, className }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center py-12 text-center',
        className
      )}
    >
      <AlertTriangle className="w-8 h-8 text-flag mb-3" aria-hidden="true" />
      <p className="text-sm font-medium text-flag max-w-md">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm',
            'bg-surface border border-line text-ivory',
            'hover:border-champagne/40 focus:outline-none focus:ring-2 focus:ring-champagne/50',
            'transition-colors'
          )}
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  )
}
