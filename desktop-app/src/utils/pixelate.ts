/**
 * @file pixelate.ts — 图片像素化工具（Canvas 实现）
 * @author zhi.qu
 * @date 2026-04-10
 *
 * 原理：将图片缩小到像素网格尺寸（如 32×32），再放大回目标尺寸。
 * 关闭 imageSmoothingEnabled 使放大时呈现锯齿像素效果。
 */

/** 像素化处理的目标尺寸（最终输出图片像素数） */
const OUTPUT_SIZE = 128

/** 像素网格密度（越小越像素风，值越大越接近原图） */
const PIXEL_GRID = 32

/**
 * 将图片 data URL 转换为像素风 data URL。
 *
 * @param dataUrl  输入图片 data URL（任意格式）
 * @param pixelGrid 像素格密度，默认 32（即 32×32 像素格）
 * @returns 输出 128×128 PNG data URL
 *
 * @example
 * const pixelated = await pixelateImage(fileDataUrl)
 */
export async function pixelateImage(
  dataUrl: string,
  pixelGrid: number = PIXEL_GRID,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()

    img.onload = () => {
      // 第一步：将图片裁剪为正方形（居中裁剪）并缩小到像素格尺寸
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      const srcX = (img.naturalWidth - side) / 2
      const srcY = (img.naturalHeight - side) / 2

      const step1 = document.createElement('canvas')
      step1.width = pixelGrid
      step1.height = pixelGrid
      const ctx1 = step1.getContext('2d')
      if (!ctx1) { reject(new Error('无法创建 Canvas 上下文')); return }

      // 缩小时关闭平滑，保留色块
      ctx1.imageSmoothingEnabled = false
      ctx1.drawImage(img, srcX, srcY, side, side, 0, 0, pixelGrid, pixelGrid)

      // 第二步：放大回目标尺寸，关闭平滑产生像素锯齿效果
      const step2 = document.createElement('canvas')
      step2.width = OUTPUT_SIZE
      step2.height = OUTPUT_SIZE
      const ctx2 = step2.getContext('2d')
      if (!ctx2) { reject(new Error('无法创建 Canvas 上下文')); return }

      ctx2.imageSmoothingEnabled = false
      ctx2.drawImage(step1, 0, 0, pixelGrid, pixelGrid, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)

      resolve(step2.toDataURL('image/png'))
    }

    img.onerror = () => reject(new Error('图片加载失败，请检查文件格式'))
    img.src = dataUrl
  })
}
