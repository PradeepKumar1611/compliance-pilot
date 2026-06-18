import { useState, useEffect, useCallback } from 'react'
import api from './api'

/**
 * Fetch data from an API endpoint with managed loading / error / data state.
 *
 * @param {string|null} url        endpoint (relative to /api); null skips the fetch
 * @param {object}      [options]  { params, immediate, transform }
 * @returns {{ data, error, loading, refetch }}
 */
export function useApi(url, { params, immediate = true, transform } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(immediate && !!url)

  const paramsKey = params ? JSON.stringify(params) : ''

  const refetch = useCallback(async () => {
    if (!url) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(url, params ? { params } : undefined)
      setData(transform ? transform(res.data) : res.data)
    } catch (err) {
      const msg =
        err.response?.data?.detail ||
        err.response?.data?.message ||
        (err.code === 'ECONNABORTED' ? 'Request timed out.' : null) ||
        'Failed to load data.'
      setError(msg)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, paramsKey])

  useEffect(() => {
    if (immediate && url) refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, paramsKey, immediate])

  return { data, error, loading, refetch }
}
