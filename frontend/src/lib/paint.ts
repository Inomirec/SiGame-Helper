import type { Stroke } from './types'

/**
 * Рисует мазки на холсте в координатах оригинала.
 *
 * Одной и той же функцией пользуются и предпросмотр поверх картинки, и
 * подготовка слоя для отправки — иначе они рано или поздно разойдутся,
 * и человек получит не то, что видел.
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  color: string,
): void {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    if (!stroke.points.length) continue
    // Ластик не рисует прозрачным цветом, а вырезает уже нарисованное.
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = stroke.size

    if (stroke.points.length === 1) {
      const point = stroke.points[0]
      ctx.beginPath()
      ctx.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }

    ctx.beginPath()
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
    for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
}

/** Готовит слой для отправки: прозрачный PNG размером с оригинал. */
export function strokesToPng(
  strokes: Stroke[],
  width: number,
  height: number,
  color: string,
): string | null {
  if (!strokes.length || !width || !height) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  drawStrokes(ctx, strokes, color)
  return canvas.toDataURL('image/png')
}
