import { createCanvas, loadImage } from '@napi-rs/canvas';
import { knowledgeLimits } from '../../shared/knowledge';

export interface OCRInput { bytes: Buffer; method: 'upscale' | 'suppress-red'; scale: number; removedPixels: number }
export async function prepareOCRInputs(bytes: Buffer): Promise<OCRInput[]> {
  const image = await loadImage(bytes);
  const scale = Math.max(1, Math.min(3, Math.ceil(2400 / image.width)));
  const factor = image.width * image.height * scale * scale <= knowledgeLimits.pixels ? scale : 1;
  const canvas = createCanvas(image.width * factor, image.height * factor), context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'; context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const inputs: OCRInput[] = [];
  if (factor > 1) inputs.push({ bytes: canvas.toBuffer('image/png'), method: 'upscale', scale: factor, removedPixels: 0 });
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height); let removed = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const r = pixels.data[i], g = pixels.data[i + 1], b = pixels.data[i + 2];
    // Keep dark printed strokes; suppress bright red stamp/background interference
    // only in a supplemental image. The original colored text remains available.
    if (r > 130 && r > g * 1.15 && r > b * 1.15) { pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255; removed++; }
  }
  if (removed >= 20 && removed / (canvas.width * canvas.height) >= 0.001) {
    context.putImageData(pixels, 0, 0); inputs.push({ bytes: canvas.toBuffer('image/png'), method: 'suppress-red', scale: factor, removedPixels: removed });
  }
  return inputs;
}
