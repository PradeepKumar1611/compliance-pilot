import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, Eye, EyeOff, Lock, ShieldCheck, FileCheck2, Sparkles } from 'lucide-react'
import api from '../lib/api'
import { useAuth, useToast } from '../App'
import { cn } from '../lib/utils'
import LanguageSwitcher from '../components/LanguageSwitcher'

export default function Login() {
  const navigate = useNavigate()
  const auth = useAuth()
  const showToast = useToast()
  const { t } = useTranslation()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  // Password change state
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [pendingAuth, setPendingAuth] = useState(null)

  async function handleLogin(e) {
    e.preventDefault()
    if (!username.trim() || !password.trim()) {
      showToast('Please enter username and password', 'error')
      return
    }
    setLoading(true)
    try {
      const res = await api.post('/auth/login', { username, password })
      const data = res.data
      const userData = { username: data.username, role: data.role }
      if (data.must_change_password) {
        setPendingAuth({ user: userData, currentPassword: password })
        setMustChangePassword(true)
      } else {
        auth.login(userData)
        navigate('/dashboard')
      }
    } catch (err) {
      const msg = err.response?.data?.detail || err.response?.data?.message || 'Invalid credentials'
      showToast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault()
    if (!newPassword.trim()) {
      showToast('Please enter a new password', 'error')
      return
    }
    if (newPassword !== confirmPassword) {
      showToast('Passwords do not match', 'error')
      return
    }
    if (newPassword.length < 8) {
      showToast('Password must be at least 8 characters', 'error')
      return
    }
    setChangingPassword(true)
    try {
      await api.post('/auth/change-password', {
        current_password: pendingAuth.currentPassword,
        new_password: newPassword,
      })
      auth.login(pendingAuth.user)
      showToast('Password changed successfully', 'success')
      navigate('/dashboard')
    } catch (err) {
      const msg = err.response?.data?.detail || 'Failed to change password'
      showToast(msg, 'error')
    } finally {
      setChangingPassword(false)
    }
  }

  const fieldClass =
    'lux-input focus:ring-1 focus:ring-champagne/40'

  return (
    <div className="relative min-h-screen overflow-hidden lg:grid lg:grid-cols-[1.05fr_0.95fr]">
      {/* Language switcher — top right */}
      <div className="absolute right-5 top-5 z-20">
        <LanguageSwitcher />
      </div>

      {/* Left — the maison hero */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-line p-12 lg:flex">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(700px 520px at 30% 20%, rgba(203,164,90,0.16), transparent 60%), radial-gradient(600px 600px at 90% 110%, rgba(138,110,59,0.12), transparent 55%)',
          }}
        />
        <div className="relative flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-md border border-champagne/50 bg-surface2 font-display text-lg text-champagne shadow-seal">
            CP
          </div>
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.28em] text-ivory-dim">
            {t('app.tagline')}
          </span>
        </div>

        <div className="relative">
          <p className="eyebrow mb-5">Private Compliance Intelligence</p>
          <h1 className="display text-6xl font-semibold leading-[0.95]">
            {t('app.name')}
          </h1>
          {/* signature: a champagne hairline that draws in on load */}
          <div className="mt-6 h-px w-56 origin-left animate-draw-line bg-gradient-to-r from-champagne via-champagne-bright to-transparent" />
          <p className="mt-6 max-w-md text-[0.95rem] leading-relaxed text-ivory-dim">
            Answer security questionnaires with the authority of your own policy
            library — every response sourced, scored, and sealed.
          </p>
        </div>

        <div className="relative flex flex-wrap gap-x-8 gap-y-3 text-sm text-ivory-dim">
          <span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-champagne" /> Sourced &amp; cited</span>
          <span className="inline-flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-champagne" /> Confidence-scored</span>
          <span className="inline-flex items-center gap-2"><Sparkles className="h-4 w-4 text-champagne" /> Auto-filled</span>
        </div>
      </aside>

      {/* Right — auth */}
      <main className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm animate-fade-in">
          {/* compact brand for mobile */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="grid h-11 w-11 place-items-center rounded-md border border-champagne/50 bg-surface2 font-display text-lg text-champagne">
              CP
            </div>
            <div className="leading-tight">
              <h1 className="display text-xl font-semibold">{t('app.name')}</h1>
              <p className="font-mono text-[0.6rem] uppercase tracking-[0.22em] text-ivory-dim">
                {t('app.tagline')}
              </p>
            </div>
          </div>

          <p className="eyebrow mb-2">{mustChangePassword ? 'Secure your account' : 'Welcome back'}</p>
          <h2 className="display mb-8 text-2xl font-medium">
            {mustChangePassword ? t('login.newPassword') : t('login.signIn')}
          </h2>

          {!mustChangePassword ? (
            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <label htmlFor="username" className="mb-1.5 block text-sm font-medium text-ivory">
                  {t('login.username')}
                </label>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('login.usernamePlaceholder')}
                  autoComplete="username"
                  className={fieldClass}
                />
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ivory">
                  {t('login.password')}
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('login.passwordPlaceholder')}
                    autoComplete="current-password"
                    className={cn(fieldClass, 'pr-10')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-ivory-dim transition-colors hover:text-champagne"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button type="submit" disabled={loading} className="lux-btn-gold w-full py-2.5">
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('login.signingIn')}
                  </>
                ) : (
                  t('login.signIn')
                )}
              </button>
            </form>
          ) : (
            <form onSubmit={handleChangePassword} className="space-y-5">
              <div className="flex items-center gap-3 rounded-md border border-review/25 bg-review/10 p-3">
                <Lock className="h-5 w-5 shrink-0 text-review" />
                <p className="text-sm text-review">{t('login.mustChange')}</p>
              </div>

              <div>
                <label htmlFor="newPassword" className="mb-1.5 block text-sm font-medium text-ivory">
                  {t('login.newPassword')}
                </label>
                <input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  autoComplete="new-password"
                  className={fieldClass}
                />
              </div>

              <div>
                <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium text-ivory">
                  {t('login.confirmPassword')}
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  className={fieldClass}
                />
              </div>

              <button type="submit" disabled={changingPassword} className="lux-btn-gold w-full py-2.5">
                {changingPassword ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('login.updating')}
                  </>
                ) : (
                  t('login.updateContinue')
                )}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}
