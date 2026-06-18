import axios from 'axios'

function getCookie(name) {
  const escaped = name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1')
  const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : null
}

const api = axios.create({
  baseURL: '/api',
  withCredentials: true, // send/receive httpOnly auth cookies
  timeout: 15000,
})

// Attach the CSRF token (double-submit) on mutating requests.
api.interceptors.request.use((config) => {
  const method = (config.method || 'get').toLowerCase()
  if (['post', 'put', 'delete', 'patch'].includes(method)) {
    const csrf = getCookie('csrf_token')
    if (csrf) config.headers['X-CSRF-Token'] = csrf
  }
  return config
})

let isRedirecting = false
let refreshPromise = null

function redirectToLogin() {
  if (isRedirecting) return
  isRedirecting = true
  localStorage.removeItem('user')
  if (window.location.pathname !== '/login') {
    window.location.href = '/login'
  }
  setTimeout(() => {
    isRedirecting = false
  }, 2000)
}

const MAX_GET_RETRIES = 2
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config
    const status = error.response?.status
    const url = original?.url || ''
    const method = (original?.method || 'get').toLowerCase()

    // Retry idempotent GETs on network errors or 5xx, with exponential backoff.
    const retriable = !error.response || status >= 500
    if (original && method === 'get' && retriable) {
      original._retryCount = original._retryCount || 0
      if (original._retryCount < MAX_GET_RETRIES) {
        original._retryCount += 1
        await sleep(300 * 2 ** (original._retryCount - 1))
        return api(original)
      }
    }

    // On 401, attempt a single silent refresh, then retry the original request.
    if (
      status === 401 &&
      original &&
      !original._retry &&
      !url.includes('/auth/refresh') &&
      !url.includes('/auth/login')
    ) {
      original._retry = true
      try {
        refreshPromise = refreshPromise || api.post('/auth/refresh')
        await refreshPromise
        refreshPromise = null
        return api(original)
      } catch (e) {
        refreshPromise = null
        redirectToLogin()
        return Promise.reject(error)
      }
    }

    if (status === 401) {
      redirectToLogin()
    }
    return Promise.reject(error)
  }
)

export default api
