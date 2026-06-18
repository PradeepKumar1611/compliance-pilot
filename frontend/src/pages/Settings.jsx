import { useState, useEffect } from 'react'
import {
  Save,
  Plug,
  CheckCircle2,
  XCircle,
  Loader2,
  Users,
  Plus,
  Trash2,
  Shield,
  KeyRound,
  Settings2,
} from 'lucide-react'
import api from '../lib/api'
import { useAuth, useToast } from '../App'
import { cn, getConfidenceBadge, truncate, formatDate } from '../lib/utils'

const DEFAULT_SETTINGS = {
  llm_provider: 'claude_code',
  ollama_url: 'http://localhost:11434',
  llm_model: 'llama3.2',
  embed_model: 'mxbai-embed-large',
  embed_url: '',
  embed_concurrency: 1,
  chunk_overlap: 150,
  ingestion_timeout: 600,
  confidence_auto_fill: 0.82,
  confidence_flag: 0.65,
  max_chunks: 5,
  max_chunk_chars: 1200,
  hybrid_alpha: 0.5,
  query_expansion_enabled: true,
  reranking_enabled: true,
}

function InputField({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-ivory">{label}</label>
      {children}
    </div>
  )
}

export default function Settings() {
  const { user } = useAuth()
  const showToast = useToast()

  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [connectionTests, setConnectionTests] = useState({})
  const [testingConnection, setTestingConnection] = useState({})

  // Change password
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)

  // User management
  const [users, setUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' })
  const [addingUser, setAddingUser] = useState(false)

  // Load settings
  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await api.get('/settings')
        setSettings((prev) => ({ ...prev, ...data }))
      } catch {
        // Use defaults
      }
    }
    if (user?.role === 'admin') load()
  }, [user])

  // Load users
  const fetchUsers = async () => {
    setLoadingUsers(true)
    try {
      const { data } = await api.get('/users')
      setUsers(Array.isArray(data) ? data : data.users || [])
    } catch {
      showToast('Failed to load users', 'error')
    } finally {
      setLoadingUsers(false)
    }
  }

  useEffect(() => {
    if (user?.role === 'admin') fetchUsers()
  }, [user])

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.put('/settings', settings)
      showToast('Settings saved successfully')
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to save settings', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleChangePassword = async (e) => {
    e.preventDefault()
    if (!currentPassword || !newPassword) {
      showToast('Please fill in all password fields', 'error')
      return
    }
    if (newPassword !== confirmNewPassword) {
      showToast('New passwords do not match', 'error')
      return
    }
    if (newPassword.length < 6) {
      showToast('Password must be at least 6 characters', 'error')
      return
    }
    setChangingPassword(true)
    try {
      await api.post('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      })
      showToast('Password changed successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to change password', 'error')
    } finally {
      setChangingPassword(false)
    }
  }

  const handleTestConnection = async (modelType) => {
    const key = modelType
    setTestingConnection((prev) => ({ ...prev, [key]: true }))
    setConnectionTests((prev) => ({ ...prev, [key]: null }))

    try {
      const payload = {
        ollama_url: modelType === 'embedding'
          ? (settings.embed_url || settings.ollama_url)
          : settings.ollama_url,
        model: modelType === 'embedding'
          ? settings.embed_model
          : settings.llm_model,
        model_type: modelType,
      }
      const { data } = await api.post('/settings/test-connection', payload)
      setConnectionTests((prev) => ({
        ...prev,
        [key]: { success: data.status === 'success', message: data.message },
      }))
    } catch (err) {
      setConnectionTests((prev) => ({
        ...prev,
        [key]: {
          success: false,
          message: err.response?.data?.detail || 'Connection failed',
        },
      }))
    } finally {
      setTestingConnection((prev) => ({ ...prev, [key]: false }))
    }
  }

  const handleChangeRole = async (userId, currentRole) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin'
    try {
      await api.put(`/users/${userId}/role`, { role: newRole })
      showToast(`Role changed to ${newRole}`)
      fetchUsers()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to change role', 'error')
    }
  }

  const handleResetPassword = async (userId) => {
    const newPassword = window.prompt('Enter new password:')
    if (!newPassword) return
    try {
      await api.post(`/users/${userId}/reset-password`, { new_password: newPassword })
      showToast('Password reset successfully')
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to reset password', 'error')
    }
  }

  const handleDeleteUser = async (userId, username) => {
    if (!window.confirm(`Are you sure you want to delete user "${username}"?`)) return
    try {
      await api.delete(`/users/${userId}`)
      showToast('User deleted')
      fetchUsers()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to delete user', 'error')
    }
  }

  const handleAddUser = async (e) => {
    e.preventDefault()
    if (!newUser.username || !newUser.password) {
      showToast('Username and password are required', 'error')
      return
    }
    setAddingUser(true)
    try {
      await api.post('/users', newUser)
      showToast('User created successfully')
      setNewUser({ username: '', password: '', role: 'user' })
      fetchUsers()
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to create user', 'error')
    } finally {
      setAddingUser(false)
    }
  }

  const inputCls =
    'block w-full rounded-lg border border-line bg-obsidian px-3 py-2 text-sm text-ivory placeholder-ivory-dim/60 focus:border-champagne focus:outline-none focus:ring-1 focus:ring-champagne transition-colors'

  function ConnectionBadge({ modelType }) {
    const result = connectionTests[modelType]
    if (!result) return null
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium',
          result.success ? 'text-approved' : 'text-flag'
        )}
      >
        {result.success ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <XCircle className="h-3.5 w-3.5" />
        )}
        {result.message}
      </span>
    )
  }

  function TestButton({ modelType }) {
    const loading = testingConnection[modelType]
    return (
      <button
        onClick={() => handleTestConnection(modelType)}
        disabled={loading}
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-obsidian px-3 py-2 text-sm text-ivory transition-colors hover:border-champagne/40 hover:bg-surface2 disabled:opacity-50"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plug className="h-3.5 w-3.5" />
        )}
        Test Connection
      </button>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-ivory">Settings</h1>
        <p className="mt-1 text-sm text-ivory-dim">Configure system parameters</p>
      </div>

      {/* Change Password Card */}
      <div className="rounded-xl border border-line bg-surface p-6 transition-shadow hover:shadow-[0_0_30px_rgba(59,130,246,0.06)]">
        <div className="flex items-center gap-2 mb-6">
          <KeyRound className="h-5 w-5 text-champagne" />
          <h2 className="text-lg font-medium text-ivory">Change Password</h2>
        </div>

        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <InputField label="Current Password">
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                className={inputCls}
              />
            </InputField>
            <InputField label="New Password">
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                className={inputCls}
              />
            </InputField>
            <InputField label="Confirm New Password">
              <input
                type="password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                placeholder="Confirm new password"
                className={inputCls}
              />
            </InputField>
          </div>
          <button
            type="submit"
            disabled={changingPassword}
            className="flex items-center gap-2 rounded-lg bg-champagne px-5 py-2.5 text-sm font-medium text-ivory transition-colors hover:bg-champagne disabled:opacity-50"
          >
            {changingPassword ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            Update Password
          </button>
        </form>
      </div>

      {/* Settings Card — Admin Only */}
      {user?.role === 'admin' && <div className="rounded-xl border border-line bg-surface p-6 transition-shadow hover:shadow-[0_0_30px_rgba(59,130,246,0.06)]">
        <div className="flex items-center gap-2 mb-6">
          <Settings2 className="h-5 w-5 text-champagne" />
          <h2 className="text-lg font-medium text-ivory">System Configuration</h2>
        </div>

        <div className="space-y-5">
          {/* LLM Provider */}
          <InputField label="LLM Provider">
            <div className="flex items-center gap-3">
              <select
                value={settings.llm_provider}
                onChange={(e) => setSettings({ ...settings, llm_provider: e.target.value })}
                className={cn(inputCls, 'w-64')}
              >
                <option value="claude_code">Claude Code (Local CLI)</option>
                <option value="ollama">Ollama (Local)</option>
              </select>
              <span className={cn(
                'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                settings.llm_provider === 'claude_code'
                  ? 'border-champagne/30 bg-champagne/20 text-champagne'
                  : 'border-approved/30 bg-approved/20 text-approved'
              )}>
                {settings.llm_provider === 'claude_code' ? 'Claude Code' : 'Ollama'}
              </span>
            </div>
          </InputField>

          {/* Claude Code Settings */}
          {settings.llm_provider === 'claude_code' && (
            <div className="rounded-lg border border-champagne/20 bg-champagne/5 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-champagne">Claude Code CLI</h3>
                  <p className="text-xs text-ivory-dim mt-1">
                    Uses the 'claude' command installed on your machine. No API key needed.
                  </p>
                </div>
                <TestButton modelType="claude_code" />
              </div>
              <ConnectionBadge modelType="claude_code" />
            </div>
          )}

          {/* Ollama Settings (shown when provider is Ollama) */}
          {settings.llm_provider === 'ollama' && (
            <div className="rounded-lg border border-approved/20 bg-approved/5 p-4 space-y-4">
              <h3 className="text-sm font-medium text-green-300">Ollama Configuration</h3>

              <InputField label="Ollama Base URL">
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={settings.ollama_url}
                    onChange={(e) => setSettings({ ...settings, ollama_url: e.target.value })}
                    className={inputCls}
                  />
                  <TestButton modelType="ollama" />
                </div>
                <ConnectionBadge modelType="ollama" />
              </InputField>

              <InputField label="LLM Model">
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={settings.llm_model}
                    onChange={(e) => setSettings({ ...settings, llm_model: e.target.value })}
                    className={inputCls}
                  />
                  <TestButton modelType="llm" />
                </div>
                <ConnectionBadge modelType="llm" />
              </InputField>
            </div>
          )}

          {/* ── Knowledge Base Settings ── */}
          <div className="rounded-lg border border-champagne/20 bg-champagne/5 p-4 space-y-5">
            <h3 className="text-sm font-medium text-champagne-bright">Knowledge Base Ingestion</h3>

            <InputField label="Embedding Service URL">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={settings.embed_url}
                  onChange={(e) => setSettings({ ...settings, embed_url: e.target.value })}
                  placeholder="Leave empty to use Ollama URL above"
                  className={inputCls}
                />
                <TestButton modelType="embedding" />
              </div>
              <ConnectionBadge modelType="embedding" />
              <p className="text-xs text-ivory-dim mt-1">
                Separate URL for embedding service (e.g., remote Ollama with a powerful GPU). Leave empty to use the LLM Ollama URL.
              </p>
            </InputField>

            <InputField label="Embedding Model">
              <div className="flex items-center gap-3">
                <select
                  value={settings.embed_model}
                  onChange={(e) => setSettings({ ...settings, embed_model: e.target.value })}
                  className={cn(inputCls, 'w-64')}
                >
                  <option value="mxbai-embed-large">mxbai-embed-large (335M, 1024d, 512 tokens)</option>
                  <option value="nomic-embed-text">nomic-embed-text (137M, 768d, 8192 tokens)</option>
                  <option value="qwen3-embedding:4b">qwen3-embedding:4b (4B, 2560d, 40K tokens)</option>
                  <option value="qwen3-embedding:8b">qwen3-embedding:8b (8B, 4096d, 40K tokens)</option>
                </select>
                <input
                  type="text"
                  value={settings.embed_model}
                  onChange={(e) => setSettings({ ...settings, embed_model: e.target.value })}
                  placeholder="Or type custom model name"
                  className={cn(inputCls, 'w-48')}
                />
              </div>
              <p className="text-xs text-amber-500/80 mt-1">Changing the embedding model requires a "Re-ingest All" to rebuild the knowledge base</p>
            </InputField>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <InputField label="Max Chunk Size (chars)">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={500}
                    max={2000}
                    step={100}
                    value={settings.max_chunk_chars}
                    onChange={(e) =>
                      setSettings({ ...settings, max_chunk_chars: parseInt(e.target.value) || 1000 })
                    }
                    className={cn(inputCls, 'w-28')}
                  />
                  <span className="text-xs text-ivory-dim">chars per KB chunk</span>
                </div>
              </InputField>

              <InputField label="Parallel Embeddings">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={32}
                    value={settings.embed_concurrency}
                    onChange={(e) =>
                      setSettings({ ...settings, embed_concurrency: parseInt(e.target.value) || 1 })
                    }
                    className={cn(inputCls, 'w-28')}
                  />
                  <span className="text-xs text-ivory-dim">1 for 16GB, 8-16 for 256GB+</span>
                </div>
              </InputField>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <InputField label="Chunk Overlap (chars)">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={500}
                    step={10}
                    value={settings.chunk_overlap}
                    onChange={(e) =>
                      setSettings({ ...settings, chunk_overlap: parseInt(e.target.value) || 0 })
                    }
                    className={cn(inputCls, 'w-28')}
                  />
                  <span className="text-xs text-ivory-dim">overlap between chunks</span>
                </div>
              </InputField>

              <InputField label="Per-doc Timeout (seconds)">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={60}
                    max={3600}
                    step={30}
                    value={settings.ingestion_timeout}
                    onChange={(e) =>
                      setSettings({ ...settings, ingestion_timeout: parseInt(e.target.value) || 600 })
                    }
                    className={cn(inputCls, 'w-28')}
                  />
                  <span className="text-xs text-ivory-dim">max time per document</span>
                </div>
              </InputField>
            </div>
          </div>

          {/* ── Retrieval & Answer Quality ── */}
          <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-4 space-y-5">
            <h3 className="text-sm font-medium text-cyan-300">Retrieval & Answer Quality</h3>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
              <InputField label="Max Chunks per Question">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={settings.max_chunks}
                  onChange={(e) =>
                    setSettings({ ...settings, max_chunks: parseInt(e.target.value) || 1 })
                  }
                  className={cn(inputCls, 'w-28')}
                />
              </InputField>

              <InputField label="Auto-fill Threshold">
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.confidence_auto_fill}
                  onChange={(e) =>
                    setSettings({ ...settings, confidence_auto_fill: parseFloat(e.target.value) || 0 })
                  }
                  className={cn(inputCls, 'w-28')}
                />
              </InputField>

              <InputField label="Flagging Threshold">
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.confidence_flag}
                  onChange={(e) =>
                    setSettings({ ...settings, confidence_flag: parseFloat(e.target.value) || 0 })
                  }
                  className={cn(inputCls, 'w-28')}
                />
              </InputField>
            </div>

            <InputField label="Hybrid Search">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-approved/10 border border-approved/20 text-xs font-medium text-approved">
                  Reciprocal Rank Fusion (RRF)
                </span>
                <span className="text-xs text-ivory-dim">
                  Dense (semantic) + Sparse (keyword) search merged by rank
                </span>
              </div>
            </InputField>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <InputField label="Query Expansion">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSettings({ ...settings, query_expansion_enabled: !settings.query_expansion_enabled })}
                    className={cn(
                      'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                      settings.query_expansion_enabled ? 'bg-champagne' : 'bg-surface2'
                    )}
                  >
                    <span className={cn(
                      'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                      settings.query_expansion_enabled ? 'translate-x-6' : 'translate-x-1'
                    )} />
                  </button>
                  <span className="text-xs text-ivory-dim">
                    Rephrase questions for broader KB search
                  </span>
                </div>
              </InputField>

              <InputField label="Re-ranking">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSettings({ ...settings, reranking_enabled: !settings.reranking_enabled })}
                    className={cn(
                      'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                      settings.reranking_enabled ? 'bg-champagne' : 'bg-surface2'
                    )}
                  >
                    <span className={cn(
                      'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                      settings.reranking_enabled ? 'translate-x-6' : 'translate-x-1'
                    )} />
                  </button>
                  <span className="text-xs text-ivory-dim">
                    LLM re-ranks chunks for better precision
                  </span>
                </div>
              </InputField>
            </div>
          </div>

          {/* Save */}
          <div className="pt-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 rounded-lg bg-champagne px-5 py-2.5 text-sm font-medium text-ivory transition-colors hover:bg-champagne disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save Settings
            </button>
          </div>
        </div>
      </div>}

      {/* User Management Card — Admin Only */}
      {user?.role === 'admin' && <div className="rounded-xl border border-line bg-surface p-6 transition-shadow hover:shadow-[0_0_30px_rgba(59,130,246,0.06)]">
        <div className="flex items-center gap-2 mb-6">
          <Users className="h-5 w-5 text-champagne" />
          <h2 className="text-lg font-medium text-ivory">User Management</h2>
        </div>

        {/* Users Table */}
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-obsidian">
                <th className="px-4 py-3 text-left font-medium text-ivory-dim">Username</th>
                <th className="px-4 py-3 text-left font-medium text-ivory-dim">Role</th>
                <th className="px-4 py-3 text-right font-medium text-ivory-dim">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {loadingUsers ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-ivory-dim">
                    Loading users...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-ivory-dim">
                    No users found.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="transition-colors hover:bg-white/[0.02]">
                    <td className="px-4 py-3 text-ivory">{u.username}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium',
                          u.role === 'admin'
                            ? 'border-champagne/30 bg-champagne/20 text-champagne'
                            : 'border-line bg-surface2/70 text-ivory-dim'
                        )}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleChangeRole(u.id, u.role)}
                          className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ivory transition-colors hover:border-champagne/50 hover:text-champagne"
                        >
                          <Shield className="h-3.5 w-3.5" />
                          {u.role === 'admin' ? 'Make User' : 'Make Admin'}
                        </button>
                        <button
                          onClick={() => handleResetPassword(u.id)}
                          className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ivory transition-colors hover:border-review/50 hover:text-review"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          Reset Password
                        </button>
                        <button
                          onClick={() => handleDeleteUser(u.id, u.username)}
                          className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ivory transition-colors hover:border-flag/50 hover:text-flag"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Add New User */}
        <form onSubmit={handleAddUser} className="mt-6">
          <h3 className="mb-3 text-sm font-medium text-ivory">Add New User</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs text-ivory-dim">Username</label>
              <input
                type="text"
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                placeholder="Username"
                className={cn(inputCls, 'w-48')}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-ivory-dim">Password</label>
              <input
                type="password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                placeholder="Password"
                className={cn(inputCls, 'w-48')}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-ivory-dim">Role</label>
              <select
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                className={cn(inputCls, 'w-32')}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={addingUser}
              className="flex items-center gap-2 rounded-lg bg-champagne px-4 py-2 text-sm font-medium text-ivory transition-colors hover:bg-champagne disabled:opacity-50"
            >
              {addingUser ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add User
            </button>
          </div>
        </form>
      </div>}
    </div>
  )
}
