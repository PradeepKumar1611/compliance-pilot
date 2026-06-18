import { useState, useRef, useEffect } from 'react'
import { Send, Loader2, Bot, User, AlertTriangle, CheckCircle2, XCircle, FileText, Trash2 } from 'lucide-react'
import api from '../lib/api'
import { useToast } from '../App'
import { cn } from '../lib/utils'

function ConfidenceBadge({ tier, score }) {
  const config = {
    auto_fill: { className: 'bg-approved/20 text-approved border-approved/30', icon: CheckCircle2, label: 'High confidence' },
    needs_review: { className: 'bg-review/20 text-review border-review/30', icon: AlertTriangle, label: 'Needs review' },
    no_answer: { className: 'bg-flag/20 text-flag border-flag/30', icon: XCircle, label: 'No answer' },
  }
  const c = config[tier] || config.no_answer
  const Icon = c.icon

  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', c.className)}>
      <Icon className="w-3 h-3" />
      {c.label} ({(score * 100).toFixed(0)}%)
    </span>
  )
}

function SourceChips({ sources }) {
  if (!sources || sources.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {sources.map((src, i) => (
        src.source_url ? (
          <a
            key={i}
            href={src.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface2/60 text-xs text-champagne border border-line/50 hover:bg-surface2/50 transition-colors"
          >
            <FileText className="w-3 h-3" />
            {src.source_file}
            {src.page_number ? `, p.${src.page_number}` : ''}
          </a>
        ) : (
        <span
          key={i}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface2/60 text-xs text-ivory-dim border border-line/50"
        >
          <FileText className="w-3 h-3" />
          {src.source_file}
          {src.page_number ? `, p.${src.page_number}` : ''}
        </span>
        )
      ))}
    </div>
  )
}

// Generic example questions shown in the empty state.
const SAMPLE_PROMPTS = [
  'Do you encrypt customer data at rest?',
  'How do you handle access control and authentication?',
  'What is your data retention and deletion policy?',
  'Do you have an incident response plan?',
]

// Persist messages outside component so they survive navigation
let _persistedMessages = []
let _pendingQuestion = null

export default function Chat() {
  const showToast = useToast()
  const [messages, setMessages] = useState(_persistedMessages)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(!!_pendingQuestion)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  // Sync to persisted store whenever messages change
  useEffect(() => {
    _persistedMessages = messages
    scrollToBottom()
  }, [messages])

  // On remount, resume pending question if one was in-flight
  useEffect(() => {
    if (_pendingQuestion) {
      const question = _pendingQuestion
      _pendingQuestion = null
      ;(async () => {
        try {
          const history = _persistedMessages
            .filter(m => !m.error)
            .slice(-6)
            .map(m => ({ role: m.role, text: m.text }))
          const { data } = await api.post('/chat', { question, history })
          setMessages((prev) => {
            const updated = [
              ...prev,
              {
                role: 'assistant',
                text: data.answer,
                confidence_tier: data.confidence_tier,
                confidence_score: data.confidence_score,
                sources: data.sources,
                kb_version: data.kb_version,
              },
            ]
            _persistedMessages = updated
            return updated
          })
        } catch {
          setMessages((prev) => {
            const updated = [...prev, { role: 'assistant', text: 'Sorry, something went wrong.', error: true }]
            _persistedMessages = updated
            return updated
          })
        } finally {
          setLoading(false)
        }
      })()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClear = () => {
    setMessages([])
    _persistedMessages = []
    _pendingQuestion = null
  }

  const sendQuestion = async (raw) => {
    const question = (raw || '').trim()
    if (!question || loading) return

    // Add user message and persist immediately
    const withUserMsg = [...messages, { role: 'user', text: question }]
    setMessages(withUserMsg)
    _persistedMessages = withUserMsg
    _pendingQuestion = question
    setInput('')
    setLoading(true)

    try {
      // Send conversation history for context-aware follow-ups
      const history = withUserMsg
        .filter(m => !m.error)
        .slice(-6)  // Last 3 exchanges
        .map(m => ({ role: m.role, text: m.text }))
      const { data } = await api.post('/chat', { question, history })
      _pendingQuestion = null
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: data.answer,
          confidence_tier: data.confidence_tier,
          confidence_score: data.confidence_score,
          sources: data.sources,
          kb_version: data.kb_version,
        },
      ])
    } catch (err) {
      _pendingQuestion = null
      const msg = err.response?.data?.detail || 'Failed to get answer'
      showToast(msg, 'error')
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: 'Sorry, something went wrong. Please try again.', error: true },
      ])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    sendQuestion(input)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-ivory">Chat</h1>
          <p className="mt-1 text-sm text-ivory-dim">
            Ask questions against your compliance knowledge base
          </p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ivory-dim transition-colors hover:border-flag/30 hover:text-flag hover:bg-flag/10"
          >
            <Trash2 className="w-4 h-4" />
            Clear Chat
          </button>
        )}
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-line bg-surface p-4 space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Bot className="w-12 h-12 text-ivory-dim mb-3" />
            <h3 className="text-lg font-medium text-ivory-dim">Ask a compliance question</h3>
            <p className="text-sm text-ivory-dim mt-1 max-w-md">
              Your question will be matched against the knowledge base and answered using the configured LLM.
            </p>
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-xl">
              {SAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => sendQuestion(prompt)}
                  className="rounded-lg border border-line bg-obsidian px-3 py-2 text-left text-sm text-ivory transition-colors hover:border-champagne/40 hover:text-ivory focus:outline-none focus:ring-2 focus:ring-champagne/50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-3 max-w-3xl',
              msg.role === 'user' ? 'ml-auto flex-row-reverse' : ''
            )}
          >
            {/* Avatar */}
            <div
              className={cn(
                'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
                msg.role === 'user'
                  ? 'bg-champagne/20 text-champagne'
                  : msg.error
                    ? 'bg-flag/20 text-flag'
                    : 'bg-champagne/20 text-champagne'
              )}
            >
              {msg.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
            </div>

            {/* Message bubble */}
            <div
              className={cn(
                'rounded-xl px-4 py-3 text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'bg-champagne/15 text-ivory border border-champagne/20'
                  : msg.error
                    ? 'bg-flag/10 text-flag border border-flag/20'
                    : 'bg-surface2/60 text-ivory border border-line/50'
              )}
            >
              <div className="whitespace-pre-wrap">{msg.text}</div>

              {/* Confidence + Sources for assistant messages */}
              {msg.role === 'assistant' && !msg.error && msg.confidence_tier && (
                <div className="mt-3 pt-3 border-t border-line/50">
                  <ConfidenceBadge tier={msg.confidence_tier} score={msg.confidence_score || 0} />
                  <SourceChips sources={msg.sources} />
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Loading indicator */}
        {loading && (
          <div className="flex gap-3 max-w-3xl">
            <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-champagne/20 text-champagne">
              <Bot className="w-4 h-4" />
            </div>
            <div className="rounded-xl px-4 py-3 bg-surface2/60 border border-line/50">
              <div className="flex items-center gap-2 text-sm text-ivory-dim">
                <Loader2 className="w-4 h-4 animate-spin" />
                Searching knowledge base...
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={handleSubmit} className="flex gap-3">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a compliance question..."
          disabled={loading}
          className="flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ivory placeholder-ivory-dim/60 focus:border-champagne focus:outline-none focus:ring-1 focus:ring-champagne transition-colors disabled:opacity-50"
          autoFocus
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex items-center gap-2 rounded-xl bg-champagne px-5 py-3 text-sm font-medium text-ivory transition-colors hover:bg-champagne disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send
        </button>
      </form>
    </div>
  )
}
