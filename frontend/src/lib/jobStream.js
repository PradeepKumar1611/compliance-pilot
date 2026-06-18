import api from './api'

const TERMINAL = ['done', 'failed', 'cancelled']

/**
 * Subscribe to a questionnaire job's status. Prefers Server-Sent Events and
 * falls back to polling if SSE is unavailable or errors.
 *
 * @param {number|string} jobId
 * @param {(data:object)=>void} onUpdate  called with each status payload
 * @param {(err:Error)=>void}  [onError]  called if the transport fails hard
 * @returns {()=>void} unsubscribe
 */
export function subscribeJob(jobId, onUpdate, onError) {
  let closed = false
  let es = null
  let pollTimer = null

  const stop = () => {
    closed = true
    if (es) { es.close(); es = null }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  const handle = (data) => {
    onUpdate(data)
    if (TERMINAL.includes(data.status)) stop()
  }

  const startPolling = () => {
    if (closed || pollTimer) return
    const poll = async () => {
      try {
        const { data } = await api.get(`/questionnaire/jobs/${jobId}`)
        handle(data)
      } catch (e) {
        stop()
        if (onError) onError(e)
      }
    }
    poll()
    pollTimer = setInterval(poll, 2500)
  }

  try {
    es = new EventSource(`/api/questionnaire/jobs/${jobId}/stream`, { withCredentials: true })
    es.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data))
      } catch {
        /* ignore malformed frame */
      }
    }
    es.onerror = () => {
      if (closed) return // normal close after terminal event
      if (es) { es.close(); es = null }
      startPolling() // degrade gracefully
    }
  } catch (e) {
    startPolling()
  }

  return stop
}
