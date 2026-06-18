import { X, CheckCircle, AlertTriangle, XCircle } from 'lucide-react'

const icons = {
  success: <CheckCircle className="w-5 h-5 text-approved" />,
  error: <XCircle className="w-5 h-5 text-flag" />,
  warning: <AlertTriangle className="w-5 h-5 text-review" />,
}

const bgColors = {
  success: 'bg-approved/10 border-approved/30',
  error: 'bg-flag/10 border-flag/30',
  warning: 'bg-review/10 border-review/30',
}

export default function Toast({ message, type = 'success', onClose }) {
  return (
    <div className="fixed top-4 right-4 z-50 animate-fade-in">
      <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${bgColors[type]} backdrop-blur-sm shadow-xl`}>
        {icons[type]}
        <span className="text-sm font-medium text-foreground">{message}</span>
        <button onClick={onClose} className="ml-2 text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
