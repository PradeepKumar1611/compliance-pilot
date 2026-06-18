import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import { SUPPORTED_LANGUAGES } from '../lib/i18n'
import { cn } from '../lib/utils'

export default function LanguageSwitcher({ className }) {
  const { i18n, t } = useTranslation()

  return (
    <label className={cn('inline-flex items-center gap-2 text-sm text-ivory', className)}>
      <Languages className="h-4 w-4 text-ivory-dim" aria-hidden="true" />
      <span className="sr-only">{t('common.language')}</span>
      <select
        aria-label={t('common.language')}
        value={i18n.resolvedLanguage}
        onChange={(e) => i18n.changeLanguage(e.target.value)}
        className={cn(
          'rounded-lg border border-line bg-obsidian px-2 py-1 text-sm text-ivory',
          'focus:outline-none focus:ring-2 focus:ring-champagne/50'
        )}
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  )
}
