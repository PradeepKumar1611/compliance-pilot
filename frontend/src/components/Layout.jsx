import { useState, useCallback, useEffect } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../App'
import LanguageSwitcher from './LanguageSwitcher'
import {
  LayoutDashboard,
  Database,
  FileQuestion,
  MessageCircle,
  ClipboardList,
  Link,
  Settings,
  LogOut,
  Activity,
  Loader2,
  Menu,
  X,
} from 'lucide-react'
import api from '../lib/api'
import { cn } from '../lib/utils'

const navItems = [
  { to: '/dashboard', key: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/knowledge-base', key: 'nav.knowledgeBase', icon: Database, adminOnly: true },
  { to: '/process', key: 'nav.process', icon: FileQuestion },
  { to: '/chat', key: 'nav.chat', icon: MessageCircle },
  { to: '/audit', key: 'nav.audit', icon: ClipboardList },
  { to: '/url-validator', key: 'nav.urlValidator', icon: Link, adminOnly: true },
  { to: '/settings', key: 'nav.settings', icon: Settings },
]

// The maison wordmark: a champagne monogram + serif name.
function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-10 w-10 place-items-center rounded-md border border-champagne/50 bg-surface2 text-champagne shadow-seal">
        <span className="font-display text-lg leading-none">CP</span>
      </div>
      <div className="leading-tight">
        <h1 className="display text-[1.05rem] font-semibold">Compliance Pilot</h1>
        <p className="font-mono text-[0.6rem] uppercase tracking-[0.24em] text-ivory-dim">
          Policy Intelligence
        </p>
      </div>
    </div>
  )
}

export default function Layout() {
  const { user, logout } = useAuth()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [healthStatus, setHealthStatus] = useState(null) // null | 'ok' | 'down'
  const [checking, setChecking] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const checkHealth = useCallback(async () => {
    setChecking(true)
    setHealthStatus(null)
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const resp = await api.get('/health', { signal: controller.signal })
      clearTimeout(timeout)
      setHealthStatus(resp.data?.status === 'ok' ? 'ok' : 'down')
    } catch {
      setHealthStatus('down')
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    checkHealth()
    const id = setInterval(checkHealth, 30000)
    return () => clearInterval(id)
  }, [checkHealth])

  const visibleNav = navItems.filter((item) => !item.adminOnly || user?.role === 'admin')

  const SidebarBody = () => (
    <>
      <div className="px-6 pt-6 pb-5">
        <Wordmark />
      </div>
      <div className="divider-gold mx-6" />

      <nav className="flex-1 space-y-1 p-4">
        {visibleNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => setDrawerOpen(false)}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-all duration-200',
                isActive
                  ? 'bg-surface2 text-champagne'
                  : 'text-ivory-dim hover:bg-surface2/60 hover:text-ivory'
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-champagne transition-all duration-200',
                    isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'
                  )}
                />
                <item.icon className="h-[1.05rem] w-[1.05rem]" />
                <span className="font-medium tracking-wide">{t(item.key)}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="space-y-3 p-4">
        <div className="divider-gold" />
        {/* Backend status */}
        <button
          onClick={checkHealth}
          disabled={checking}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-ivory-dim transition-colors hover:bg-surface2/60 hover:text-ivory disabled:opacity-50"
        >
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          <span className="flex-1 text-left">{checking ? 'Checking…' : 'Backend Status'}</span>
          {healthStatus && !checking && (
            <span
              className={cn(
                'rounded-full border px-1.5 py-0.5 font-mono text-[10px] tracking-wider',
                healthStatus === 'ok'
                  ? 'border-approved/40 bg-approved/15 text-approved'
                  : 'border-flag/40 bg-flag/15 text-flag'
              )}
            >
              {healthStatus === 'ok' ? 'UP' : 'DOWN'}
            </span>
          )}
        </button>

        {/* User */}
        <div className="flex items-center gap-3 px-3">
          <div className="grid h-9 w-9 place-items-center rounded-full border border-champagne/40 bg-surface2 font-display text-champagne">
            {user?.username?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ivory">{user?.username}</p>
            <p className="font-mono text-[0.65rem] uppercase tracking-wider text-ivory-dim">{user?.role}</p>
          </div>
        </div>

        <div className="px-3">
          <LanguageSwitcher />
        </div>

        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-ivory-dim transition-colors hover:bg-flag/10 hover:text-flag"
        >
          <LogOut className="h-4 w-4" />
          {t('nav.logout')}
        </button>
      </div>
    </>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface/70 backdrop-blur lg:flex">
        <SidebarBody />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-obsidian/70 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute left-0 top-0 flex h-full w-72 animate-slide-in-right flex-col border-r border-line bg-surface">
            <button
              onClick={() => setDrawerOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-4 rounded-md p-1 text-ivory-dim hover:text-ivory"
            >
              <X className="h-5 w-5" />
            </button>
            <SidebarBody />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-line bg-surface/70 px-4 py-3 backdrop-blur lg:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1.5 text-ivory-dim hover:text-champagne"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Wordmark />
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] animate-fade-in px-5 py-8 sm:px-8 lg:px-10">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
