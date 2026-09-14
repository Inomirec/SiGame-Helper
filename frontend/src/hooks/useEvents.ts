import { useEffect } from 'react'
import { plural } from '../lib/format'
import { scheduleLibraryRefresh, useStore } from '../store'
import type { Job } from '../lib/types'

/**
 * Пачка файлов заканчивается очередью сообщений подряд. Пока они идут,
 * показываем одну плашку со счётчиком вместо сотни отдельных.
 */
let doneStreak = 0
let doneAt = 0
let failStreak = 0
let failAt = 0

function streak(previous: number, at: number): number {
  return Date.now() - at > 5000 ? 1 : previous + 1
}

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
            failStreak = streak(failStreak, failAt)
            failAt = Date.now()
            store.toast(
              failStreak === 1
                ? `«${job.title}» — ошибка: ${job.error ?? 'неизвестно'}`
                : `Не удалось обработать ${failStreak} ${plural(failStreak, ['файл', 'файла', 'файлов'])} — подробности в очереди`,
              'error',
              'job-error',
            )
          } else if (job.status === 'done') {
            doneStreak = streak(doneStreak, doneAt)
            doneAt = Date.now()
            store.toast(
              doneStreak === 1
                ? `Готово: ${job.title}`
                : `Готово: ${doneStreak} ${plural(doneStreak, ['файл', 'файла', 'файлов'])}`,
              'ok',
              'job-done',
            )
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
