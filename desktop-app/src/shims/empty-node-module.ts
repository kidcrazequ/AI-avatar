/**
 * 浏览器环境下的 Node 模块 stub。
 *
 * `@antv/infographic` 的间接依赖（postcss / source-map-js / linkedom 等）会 import
 * Node 内置模块 path / fs / url / source-map-js，但实际渲染路径里**不会真的访问**
 * fs.readFileSync 之类的函数（它们走的是 server-side 路径，浏览器走 DOM 路径）。
 *
 * Vite 默认把这些 Node 内置模块 externalize，运行时**访问 getter** 时打
 * "Module has been externalized for browser compatibility" 警告（即使不真的调用方法）。
 * 噪音很大（每次 infographic 渲染前 12+ 条），看不清真问题。
 *
 * 这个 stub 通过 vite.config.ts 的 resolve.alias 把这些 import 重定向到本文件，
 * 提供 noop 实现：调用时返回安全默认值（不抛错，避免破坏 antv 的 try/catch 逻辑），
 * 但属性访问不再触发 externalize 警告。
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

// path 模块的常用 API：返回字符串处理结果（浏览器无文件系统语义，用字符串规则模拟）
export const isAbsolute = (p: string): boolean => typeof p === 'string' && p.startsWith('/')
export const resolve = (...parts: string[]): string => parts.filter(Boolean).join('/')
export const dirname = (p: string): string => (p || '').replace(/\/[^/]+\/?$/, '') || '.'
export const basename = (p: string, ext?: string): string => {
  const last = (p || '').split('/').pop() || ''
  return ext && last.endsWith(ext) ? last.slice(0, -ext.length) : last
}
export const join = (...parts: string[]): string => parts.filter(Boolean).join('/')
export const relative = (_from: string, to: string): string => to
export const sep = '/'
export const extname = (p: string): string => {
  const m = (p || '').match(/\.[^./]+$/)
  return m ? m[0] : ''
}

// fs 模块：浏览器没文件系统，全部返回 noop 默认值（不抛错，让 antv 的 try/catch 顺利退化）
export const existsSync = (): boolean => false
export const readFileSync = (): string => ''
export const writeFileSync = (): void => undefined
export const statSync = (): { isFile: () => boolean; isDirectory: () => boolean } => ({
  isFile: () => false,
  isDirectory: () => false,
})

// url 模块
export const fileURLToPath = (u: string): string => u
export const pathToFileURL = (p: string): { href: string; pathname: string } => ({ href: p, pathname: p })

// source-map-js 的 Consumer / Generator：构造时不抛错，但 toString/eachMapping 等返回空
export class SourceMapConsumer {
  // 真实 API 是 async 的，这里同步返回空实例
  constructor(_rawSourceMap?: unknown) {}
  destroy(): void {}
  originalPositionFor(): { source: null; line: null; column: null; name: null } {
    return { source: null, line: null, column: null, name: null }
  }
  generatedPositionFor(): { line: null; column: null } {
    return { line: null, column: null }
  }
  eachMapping(): void {}
  static with<T>(_rawSourceMap: unknown, _sourceMapUrl: unknown, callback: (consumer: SourceMapConsumer) => T): Promise<T> {
    return Promise.resolve(callback(new SourceMapConsumer()))
  }
}

export class SourceMapGenerator {
  constructor(_options?: unknown) {}
  addMapping(): void {}
  setSourceContent(): void {}
  toString(): string {
    return '{"version":3,"sources":[],"names":[],"mappings":""}'
  }
  toJSON(): { version: number; sources: never[]; names: never[]; mappings: string } {
    return { version: 3, sources: [], names: [], mappings: '' }
  }
}

// CommonJS 兼容 default export（部分包用 `import path from 'path'` 形式）
const defaultExport = {
  isAbsolute,
  resolve,
  dirname,
  basename,
  join,
  relative,
  sep,
  extname,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  fileURLToPath,
  pathToFileURL,
  SourceMapConsumer,
  SourceMapGenerator,
}

export default defaultExport
