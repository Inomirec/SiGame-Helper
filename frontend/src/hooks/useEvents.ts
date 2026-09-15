import { useEffect } from 'react'
import { plural } from '../lib/format'
import { scheduleLibraryRefresh, useStore } from '../store'
import type { Job } from '../lib/types'

/**
 * Пачка файлов заканчивается очередью сообщений подряд. Пока они идут,
 * показываем одну плашку со счётчиком вместо сотни отдельных.
 */
let failStreak = 0
let failAt = 0

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
          // Об успехе плашка не всплывает: об этом и так говорит строка
          // очереди — счётчик готовых там же, где кнопки, к которым человек
          // тянется следующим движением. Ошибку показываем, её легко
          // пропустить: строка очереди одна, а ошибка требует решения.
          if (job.status === 'error') {
            failStreak = Date.now() - failAt > 5000 ? 1 : failStreak + 1
            failAt = Date.now()
            store.toast(
              failStreak === 1
                ? `«${job.title}» — ошибка: ${job.error ?? 'неизвестно'}`
                : `Не удалось обработать ${failStreak} ${plural(failStreak, ['файл', 'файла', 'файлов'])} — подробности в очереди`,
              'error',
              'job-error',
            )
          }
          scheduleLibraryRefresh()
          break
        }

        case 'job.log': {
          // Записи копим только у той задачи, чей журнал раскрыт. Иначе
          // каждая строка ffmpeg перебирала весь список задач и обновляла
          // хранилище — при очереди в несколько сотен файлов окно вставало.
          const { logJobId, jobs } = useStore.getState()
          if (!logJobId || logJobId !== payload.data.id) break
          const target = jobs.find((item) => item.id === logJobId)
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
