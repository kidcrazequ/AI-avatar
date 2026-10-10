import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { JSDOM } from 'jsdom';
import { imageSize } from 'image-size';
import { createWorker, type Worker as OCRWorker } from 'tesseract.js';
import { DocumentParser, isGarbledText } from '../../../desktop-app/electron/document-parser';
import { decodeText, parseTables, tablePreview } from './table-parser';
import { extractionSignature, knowledgeFormats, knowledgeLimits, type SourceManifest, type SourceLocation, type SourceAsset } from '../../shared/knowledge';

export const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
export interface ExtractionInput { file: string; relativePath: string; output: string; documentId: string; version: string; languages: string; signature: string }
function boundedZip(file: string): AdmZip {
  const zip = new AdmZip(file); let bytes = 0;
  const entries = zip.getEntries();
  if (entries.length > 30_000) throw new Error('Office 文件成员过多');
  for (const entry of entries) { bytes += entry.header.size; if (entry.header.size > knowledgeLimits.fileBytes || bytes > knowledgeLimits.batchBytes) throw new Error('Office 解压大小超过上限'); }
  return zip;
}

export async function extractSource(input: ExtractionInput): Promise<SourceManifest> {
  const extension = path.extname(input.file).slice(1).toLowerCase();
  const kind = knowledgeFormats.find(format => (format.extensions as readonly string[]).includes(extension))?.kind;
  if (!kind) throw new Error('不支持的知识资料格式');
  fs.mkdirSync(input.output, { recursive: true });
  const bytes = fs.readFileSync(input.file);
  if (bytes.length > knowledgeLimits.fileBytes) throw new Error('原件超过大小上限');
  const original = 'original.' + extension; fs.writeFileSync(path.join(input.output, original), bytes, { flag: 'wx' });
  const warnings: string[] = [], locations: SourceLocation[] = [], assets: SourceAsset[] = [], tables: SourceManifest['tables'] = [];
  const sections: string[] = []; let line = 1;
  const append = (body: string, location: Omit<SourceLocation, 'lineStart' | 'lineEnd'>) => {
    const normalized = body.replace(/\r\n?/g, '\n').trim();
    if (!normalized) return;
    const n = normalized.split('\n').length; locations.push({ ...location, lineStart: line, lineEnd: line + n - 1 });
    sections.push(normalized); line += n + 1;
  };
  let ocr: OCRWorker | undefined;
  const ocrCache = new Map<string, { text: string; confidence: number }>();
  const recognize = async (file: string) => {
    // Both language files and the WASM core are shipped locally; no model or CDN.
    ocr ??= await createWorker(['chi_sim', 'eng'], 1, { langPath: input.languages, cacheMethod: 'none', gzip: true, errorHandler: () => {} });
    const result = await ocr.recognize(file);
    return { text: result.data.text.trim(), confidence: result.data.confidence };
  };
  const asset = async (data: Buffer, origin: string, ext: string, position: { page?: number; slide?: number } = {}) => {
    const relative = `_assets/${String(assets.length + 1).padStart(4, '0')}.${ext}`;
    const target = path.join(input.output, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
    const record: SourceAsset = { path: relative, sha256: sha256(data), bytes: data.length, origin, ...position, ocr: 'unsupported', text: '' }; assets.push(record);
    if (!/^(png|jpe?g|bmp|gif|webp)$/i.test(ext)) { warnings.push(`图片 ${origin} 保留原件，当前 OCR 不支持 ${ext}`); return; }
    try {
      const size = imageSize(data);
      if (!size.width || !size.height || size.width * size.height > knowledgeLimits.pixels) throw new Error('图片像素超过 OCR 上限');
      let result = ocrCache.get(record.sha256);
      if (!result) { if (ocrCache.size >= knowledgeLimits.ocrPages) throw new Error('图片 OCR 数量超过上限，原图保留'); result = await recognize(target); ocrCache.set(record.sha256, result); }
      record.text = result.text; record.confidence = result.confidence; record.ocr = result.text ? 'recognized' : 'empty';
      if (!result.text) warnings.push(`图片 ${origin} 未识别出文字`);
      else append(`### ${position.page ? `第 ${position.page} 页` : position.slide ? `第 ${position.slide} 页` : origin} · OCR\n\n${result.text}`, { kind: 'asset', page: position.page ?? position.slide, asset: relative, method: 'ocr' });
    } catch (cause) { record.ocr = 'failed'; record.error = cause instanceof Error ? cause.message : String(cause); warnings.push(`图片 ${origin} OCR 失败：${record.error}`); }
  };
  try {
    if (kind === 'table') {
      const parsed = parseTables(input.file); fs.mkdirSync(path.join(input.output, '_tables'));
      parsed.forEach((table, index) => {
        const relative = `_tables/${index + 1}.json`, serialized = JSON.stringify(table); fs.writeFileSync(path.join(input.output, relative), serialized);
        tables.push({ path: relative, sha256: sha256(serialized), sheet: table.sheet, cells: table.cells.length, rows: table.rows, columns: table.columns });
        append(tablePreview(table), { kind: 'sheet', sheet: table.sheet, rowStart: 1, rowEnd: table.rows, method: 'native' });
      });
    } else if (kind === 'text') append(decodeText(bytes).text, { kind: 'text', method: 'native' });
    else if (kind === 'html') {
      // Keep Soul's full-body extraction: selecting one <article> lost source cards.
      const dom = new JSDOM(decodeText(bytes).text);
      try {
        const document = dom.window.document;
        document.querySelectorAll('script, style, noscript, template').forEach(el => el.remove());
        document.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')));
        document.querySelectorAll('p, div, section, article, header, footer, main, aside, nav, li, tr, h1, h2, h3, h4, h5, h6').forEach(el => el.appendChild(document.createTextNode('\n')));
        const content = (document.body?.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        append((document.title && !content.includes(document.title) ? document.title + '\n\n' : '') + content, { kind: 'text', method: 'native' });
      } finally { dom.window.close(); }
    } else if (kind === 'word') {
      const zip = boundedZip(input.file);
      const parsed = await new DocumentParser().parseFile(input.file);
      append(parsed.text, { kind: 'text', method: 'native' });
      for (const entry of zip.getEntries().filter(e => /^word\/media\//.test(e.entryName) && !e.isDirectory)) await asset(entry.getData(), entry.entryName, path.extname(entry.entryName).slice(1).toLowerCase());
    } else if (kind === 'slides') {
      const zip = boundedZip(input.file);
      const slides = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).sort((a, b) => Number(a.entryName.match(/slide(\d+)/)![1]) - Number(b.entryName.match(/slide(\d+)/)![1]));
      if (!slides.length || slides.length > knowledgeLimits.pages) throw new Error('幻灯片数量不符合导入上限');
      const used = new Set<string>();
      for (const slide of slides) {
        const number = Number(slide.entryName.match(/slide(\d+)/)![1]);
        const dom = new JSDOM(slide.getData().toString('utf8'), { contentType: 'text/xml' });
        try {
          const text = [...dom.window.document.getElementsByTagName('a:t')].map(el => el.textContent?.trim()).filter(Boolean).join('\n');
          // Text nodes include table cells; the boundary excludes a:tblPr/a:tc.
          append(`## 第 ${number} 页\n\n${text}`, { kind: 'slide', page: number, method: 'native' });
        } finally { dom.window.close(); }
        const rel = zip.getEntry(`ppt/slides/_rels/slide${number}.xml.rels`);
        if (rel) {
          const dom = new JSDOM(rel.getData().toString('utf8'), { contentType: 'text/xml' });
          try {
            for (const r of [...dom.window.document.getElementsByTagName('Relationship')]) {
              if (r.getAttribute('TargetMode') === 'External' || !r.getAttribute('Type')?.endsWith('/image')) continue;
              const target = path.posix.normalize(path.posix.join('ppt/slides', r.getAttribute('Target') || ''));
              const image = target.startsWith('ppt/media/') ? zip.getEntry(target) : null;
              if (image && !used.has(`${number}:${target}`)) { used.add(`${number}:${target}`); await asset(image.getData(), target, path.posix.extname(target).slice(1).toLowerCase(), { slide: number }); }
            }
          } finally { dom.window.close(); }
        }
      }
    } else if (kind === 'image') await asset(bytes, path.basename(input.relativePath), extension);
    else if (kind === 'pdf') {
      (globalThis as Record<string, unknown>).pdfjsWorker = require(path.join(__dirname, 'pdf-worker.cjs'));
      const { PDFParse } = require('pdf-parse') as typeof import('pdf-parse');
      const pdf = new PDFParse({ data: bytes });
      try {
        const info = await pdf.getInfo();
        if (info.total > knowledgeLimits.pages) throw new Error('PDF 页数超过上限');
        const text = await pdf.getText(); let ocrPages = 0;
        for (const page of text.pages) {
          append(`## 第 ${page.num} 页 · 原生文字\n\n${page.text}`, { kind: 'page', page: page.num, method: 'native' });
          const stripped = page.text.replace(/\s/g, '');
          if (stripped.length >= 300 && !isGarbledText(page.text)) continue;
          if (++ocrPages > knowledgeLimits.ocrPages) { warnings.push(`第 ${page.num} 页需要 OCR，已超过本批 OCR 页数上限`); continue; }
          try {
            const result = await pdf.getScreenshot({ partial: [page.num], desiredWidth: 2400, imageDataUrl: false, imageBuffer: true });
            if (result.pages.length !== 1 || result.pages[0].pageNumber !== page.num) throw new Error('PDF 渲染页码不匹配');
            await asset(Buffer.from(result.pages[0].data), `PDF 第 ${page.num} 页`, 'png', { page: page.num });
          } catch (cause) { warnings.push(`第 ${page.num} 页渲染失败：${cause instanceof Error ? cause.message : String(cause)}`); }
        }
      } finally { await pdf.destroy(); }
    }
  } finally { await ocr?.terminate(); }
  const body = sections.join('\n\n');
  if (!body.replace(/^#{1,6}[^\n]*$/gm, '').trim() && !tables.some(table => table.cells)) throw new Error('没有提取到可用正文或表格，原有版本保留');
  if (Buffer.byteLength(body) > knowledgeLimits.bodyBytes) throw new Error('提取正文超过上限，未截断发布');
  fs.writeFileSync(path.join(input.output, 'body.md'), body);
  const manifest: SourceManifest = { schema: 1, documentId: input.documentId, version: input.version, relativePath: input.relativePath, originalName: path.basename(input.relativePath), original, originalSha256: sha256(bytes), originalBytes: bytes.length, signature: input.signature, created: new Date().toISOString(), bodySha256: sha256(body), bodyBytes: Buffer.byteLength(body), status: warnings.length ? 'partial' : 'ready', warnings, locations, assets, tables };
  fs.writeFileSync(path.join(input.output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
