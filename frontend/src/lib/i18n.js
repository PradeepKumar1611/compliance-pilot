import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

// Starter resources. New strings/pages adopt the same `t('key')` pattern and
// add their keys to each locale below.
const resources = {
  en: {
    translation: {
      app: { name: 'Compliance Pilot', tagline: 'Policy Intelligence Platform' },
      nav: {
        dashboard: 'Dashboard',
        knowledgeBase: 'Knowledge Base',
        process: 'Process Questionnaire',
        chat: 'Chat',
        audit: 'Audit Log',
        urlValidator: 'URL Validator',
        settings: 'Settings',
        logout: 'Log out',
      },
      common: {
        retry: 'Retry',
        loading: 'Loading…',
        save: 'Save',
        cancel: 'Cancel',
        language: 'Language',
      },
      login: {
        username: 'Username',
        password: 'Password',
        usernamePlaceholder: 'Enter your username',
        passwordPlaceholder: 'Enter your password',
        signIn: 'Sign in',
        signingIn: 'Signing in...',
        mustChange: 'You must change your password before continuing.',
        newPassword: 'New Password',
        confirmPassword: 'Confirm Password',
        updateContinue: 'Update password & continue',
        updating: 'Updating password...',
      },
    },
  },
  es: {
    translation: {
      app: { name: 'Compliance Pilot', tagline: 'Plataforma de Inteligencia de Políticas' },
      nav: {
        dashboard: 'Panel',
        knowledgeBase: 'Base de Conocimiento',
        process: 'Procesar Cuestionario',
        chat: 'Chat',
        audit: 'Registro de Auditoría',
        urlValidator: 'Validador de URL',
        settings: 'Configuración',
        logout: 'Cerrar sesión',
      },
      common: {
        retry: 'Reintentar',
        loading: 'Cargando…',
        save: 'Guardar',
        cancel: 'Cancelar',
        language: 'Idioma',
      },
      login: {
        username: 'Usuario',
        password: 'Contraseña',
        usernamePlaceholder: 'Ingrese su usuario',
        passwordPlaceholder: 'Ingrese su contraseña',
        signIn: 'Iniciar sesión',
        signingIn: 'Iniciando sesión...',
        mustChange: 'Debe cambiar su contraseña antes de continuar.',
        newPassword: 'Nueva contraseña',
        confirmPassword: 'Confirmar contraseña',
        updateContinue: 'Actualizar contraseña y continuar',
        updating: 'Actualizando contraseña...',
      },
    },
  },
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: ['en', 'es'],
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'lang',
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
  })

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
]

export default i18n
