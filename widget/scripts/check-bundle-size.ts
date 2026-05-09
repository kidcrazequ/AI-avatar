/**
 * 体积守卫：build 完后读取 dist/soul-embed.js，计算 raw / minified / gzipped 大小并校验阈值。
 *
 * 阈值（与子任务说明对齐）：
 *   - gzipped > 50KB → 黄色警告（不阻塞）
 *   - gzipped > 150KB → 红色错误 + process.exit(1)
 *   - minified（即文件大小，构建已 esbuild minify）> 150KB → 同样视为超标
 *
 * 仅依赖 Node 标准库 zlib + fs，不引入第三方包。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
import { readFileSync, statSync } from 'fs'
import { gzipSync } from 'zlib'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BUNDLE_PATH = resolve(__dirname, '..', 'dist', 'soul-embed.js')
const GZIP_WARN_LIMIT = 50 * 1024
const HARD_LIMIT = 150 * 1024

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
}

function fmt(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`
  return `${n} B`
}

function main(): void {
  let bundleStat
  try {
    bundleStat = statSync(BUNDLE_PATH)
  } catch (err) {
    console.error(`${COLORS.red}[check-bundle-size] 找不到产物：${BUNDLE_PATH}${COLORS.reset}`)
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const buf = readFileSync(BUNDLE_PATH)
  const gz = gzipSync(buf, { level: 9 })

  console.log('')
  console.log(`${COLORS.cyan}[check-bundle-size] dist/soul-embed.js${COLORS.reset}`)
  console.log(`  minified : ${fmt(bundleStat.size)}`)
  console.log(`  gzipped  : ${fmt(gz.length)}`)
  console.log(`  目标     : gzipped < ${fmt(GZIP_WARN_LIMIT)}（警告） / < ${fmt(HARD_LIMIT)}（硬上限）`)

  let exitCode = 0
  if (gz.length > HARD_LIMIT) {
    console.error(
      `${COLORS.red}[check-bundle-size] 体积超出硬上限：gzipped ${fmt(gz.length)} > ${fmt(HARD_LIMIT)}${COLORS.reset}`,
    )
    exitCode = 1
  } else if (bundleStat.size > HARD_LIMIT) {
    console.error(
      `${COLORS.red}[check-bundle-size] 体积超出硬上限：minified ${fmt(bundleStat.size)} > ${fmt(HARD_LIMIT)}${COLORS.reset}`,
    )
    exitCode = 1
  } else if (gz.length > GZIP_WARN_LIMIT) {
    console.warn(
      `${COLORS.yellow}[check-bundle-size] 警告：gzipped ${fmt(gz.length)} > ${fmt(GZIP_WARN_LIMIT)}（建议优化但不阻塞）${COLORS.reset}`,
    )
  } else {
    console.log(`${COLORS.green}[check-bundle-size] 体积达标 ✅${COLORS.reset}`)
  }

  process.exit(exitCode)
}

main()
