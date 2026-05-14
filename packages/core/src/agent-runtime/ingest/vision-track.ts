/**
 * Vision 双轨：Tesseract OCR + Vision LLM caption 并行。
 *
 * 两条 track 独立：任一失败不影响另一条；都失败时返回空结果，由
 * consistency-checker 检测到"OCR 覆盖率不足"提示用户。
 *
 * Tesseract 实现由调用方注入（避免 packages/core 强依赖 tesseract.js）；
 * Vision LLM 同理。
 */

import type {
  ExtractedImage,
  OcrAdapter,
  OcrResult,
  VisionCaption,
  VisionLLMAdapter,
  VisionTrackResult,
} from './types'

export interface VisionTrackOptions {
  ocr?: OcrAdapter
  visionLLM?: VisionLLMAdapter
  /** 单 track 超时（ms），默认 60s */
  timeoutMs?: number
  onError?: (track: 'ocr' | 'vision', err: unknown) => void
}

export async function runVisionTrack(
  images: readonly ExtractedImage[],
  opts: VisionTrackOptions
): Promise<VisionTrackResult> {
  if (images.length === 0) return { ocr: [], captions: [] }
  const timeout = opts.timeoutMs ?? 60_000

  const ocrPromise: Promise<OcrResult[]> = opts.ocr
    ? withTimeout(opts.ocr.recognize(images), timeout, []).catch((err) => {
        opts.onError?.('ocr', err)
        return []
      })
    : Promise.resolve([])

  const captionPromise: Promise<VisionCaption[]> = opts.visionLLM
    ? withTimeout(opts.visionLLM.caption(images), timeout, []).catch((err) => {
        opts.onError?.('vision', err)
        return []
      })
    : Promise.resolve([])

  const [ocr, captions] = await Promise.all([ocrPromise, captionPromise])
  return { ocr, captions }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}
