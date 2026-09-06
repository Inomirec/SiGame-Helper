import { useEffect } from 'react'
import { scheduleLibraryRefresh, useStore } from '../store'
import type { Job } from '../lib/types'

/**
 * Одно SSE-соединение на всё приложение: прогресс задач, изменения медиатеки.
 * EventSource сам переподключается при обрыве, нам остаётся отражать состояние.
 */
export function useEvents() {
  useEffect(() => {
    const source = new EventSource('/api/events')

    source.onopen = () => useStore.getState().setConnected(true)
    source.onerror = () => useStore.getState().setConnected(false)

    source.onmessage = (event) => {
      let payload: { event: string; data: any }
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }

      const store = useStore.getState()
      switch (payload.event) {
        case 'hello':
          store.setConnected(true)
          break

        case 'job.created':
        case 'job.updated':
          store.upsertJob(payload.data as Job)
          break

        case 'job.finished': {
          const job = payload.data as Job
          store.upsertJob(job)
          if (job.status === 'error') {
            store.toast(`«${job.title}» — ошибка: ${job.error ?? 'неизвестно'}`, 'error')
          } else if (job.status === 'done') {
            store.toast(`Готово: ${job.title}`, 'ok')
          }
          scheduleLibraryRefresh()
          break
        }

        case 'job.log': {
          // Логи держим только у той задачи, что открыта в подробностях.
          const { jobs } = useStore.getState()
          const target = jobs.find((item) => item.id === payload.data.id)
          if (target) {
            const log = [...(target.log ?? []), payload.data.line].slice(-300)
            store.upsertJob({ ...target, log })
          }
          break
        }

        case 'library.changed':
          scheduleLibraryRefresh()
          break

        case 'jobs.cleared':
          void store.refreshJobs()
          break
      }
    }

    return () => source.close()
  }, [])
}
