/**
 * 图标生成脚本 - 从源图片生成 macOS (.icns) 和 Windows (.ico) 图标
 * @author zhi.qu
 * @date 2026-04-03
 *
 * 用法:
 *   node scripts/generate-icons.js [源图片路径]
 *
 * 支持的源格式: PNG (推荐 1024x1024), SVG
 * 如不指定源图片，默认使用 build/icon.svg
 *
 * macOS 依赖: sips, iconutil (系统自带)
 * Windows .ico 生成: 使用 png-to-ico 包
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const BUILD_DIR = path.join(__dirname, '..', 'build')
const DEFAULT_SVG = path.join(BUILD_DIR, 'icon.svg')

const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function log(msg) {
  console.log(`🎨 ${msg}`)
}

function error(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

/**
 * SVG → PNG 转换（使用 macOS qlmanage 或 rsvg-convert）
 */
function svgToPng(svgPath, pngPath, size) {
  try {
    execSync(`which rsvg-convert`, { stdio: 'ignore' })
    execSync(`rsvg-convert -w ${size} -h ${size} "${svgPath}" -o "${pngPath}"`)
    return true
  } catch {
    // 回退: 使用 qlmanage (macOS 内置)
  }

  try {
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'icon-'))
    execSync(`qlmanage -t -s ${size} -o "${tmpDir}" "${svgPath}" 2>/dev/null`)
    const generated = fs.readdirSync(tmpDir).find(f => f.endsWith('.png'))
    if (generated) {
      fs.copyFileSync(path.join(tmpDir, generated), pngPath)
      fs.rmSync(tmpDir, { recursive: true })
      return true
    }
    fs.rmSync(tmpDir, { recursive: true })
  } catch {
    // qlmanage 也失败
  }

  return false
}

/**
 * 用 sips 缩放 PNG 到指定尺寸
 */
function resizePng(srcPng, destPng, size) {
  execSync(`sips -z ${size} ${size} "${srcPng}" --out "${destPng}" 2>/dev/null`)
}

/**
 * 生成 macOS .icns 文件
 */
function generateIcns(sourcePng) {
  log('生成 macOS .icns 图标...')
  const iconsetDir = path.join(BUILD_DIR, 'icon.iconset')
  if (fs.existsSync(iconsetDir)) {
    fs.rmSync(iconsetDir, { recursive: true })
  }
  fs.mkdirSync(iconsetDir, { recursive: true })

  const pairs = [
    { name: 'icon_16x16.png', size: 16 },
    { name: 'icon_16x16@2x.png', size: 32 },
    { name: 'icon_32x32.png', size: 32 },
    { name: 'icon_32x32@2x.png', size: 64 },
    { name: 'icon_128x128.png', size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png', size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png', size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 },
  ]

  for (const { name, size } of pairs) {
    const dest = path.join(iconsetDir, name)
    resizePng(sourcePng, dest, size)
  }

  const icnsPath = path.join(BUILD_DIR, 'icon.icns')
  execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`)
  fs.rmSync(iconsetDir, { recursive: true })
  log(`✅ macOS 图标: ${icnsPath}`)
}

/**
 * 生成 Windows .ico 文件
 * 现代 ICO 格式直接嵌入 PNG 数据，兼容 Windows Vista+ 所有版本
 */
function generateIco(sourcePng) {
  log('生成 Windows .ico 图标...')
  const icoPath = path.join(BUILD_DIR, 'icon.ico')

  const tmpDir = path.join(BUILD_DIR, '.ico-tmp')
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  const sizes = [256, 128, 64, 48, 32, 16]
  const pngBuffers = []

  for (const size of sizes) {
    const tmpPng = path.join(tmpDir, `${size}.png`)
    try {
      execSync(`sips -z ${size} ${size} "${sourcePng}" --out "${tmpPng}" 2>/dev/null`)
      pngBuffers.push({ size, data: fs.readFileSync(tmpPng) })
    } catch (e) {
      log(`⚠️  跳过 ${size}x${size}: ${e.message}`)
    }
  }

  fs.rmSync(tmpDir, { recursive: true })

  if (pngBuffers.length === 0) {
    log('⚠️  无法生成 .ico，将使用 PNG 让 electron-builder 自动转换')
    return
  }

  // ICO header: 2(reserved) + 2(type=1) + 2(count)
  const headerSize = 6
  const dirEntrySize = 16
  const numImages = pngBuffers.length
  const totalHeaderSize = headerSize + dirEntrySize * numImages

  let offset = totalHeaderSize
  const dirEntries = []
  for (const { size, data } of pngBuffers) {
    const w = size >= 256 ? 0 : size
    const h = size >= 256 ? 0 : size
    const entry = Buffer.alloc(dirEntrySize)
    entry.writeUInt8(w, 0)
    entry.writeUInt8(h, 1)
    entry.writeUInt8(0, 2)    // color palette
    entry.writeUInt8(0, 3)    // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    dirEntries.push(entry)
    offset += data.length
  }

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)          // reserved
  header.writeUInt16LE(1, 2)          // type: ICO
  header.writeUInt16LE(numImages, 4)  // image count

  const ico = Buffer.concat([header, ...dirEntries, ...pngBuffers.map(p => p.data)])
  fs.writeFileSync(icoPath, ico)
  log(`✅ Windows 图标: ${icoPath} (${numImages} 种尺寸)`)
}

/**
 * 主流程
 */
function main() {
  const sourceArg = process.argv[2]
  let sourcePng = path.join(BUILD_DIR, 'icon.png')

  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true })
  }

  // 确定源文件
  if (sourceArg) {
    const absSource = path.resolve(sourceArg)
    if (!fs.existsSync(absSource)) {
      error(`源文件不存在: ${absSource}`)
    }
    if (absSource.endsWith('.svg')) {
      log(`从 SVG 转换: ${absSource}`)
      if (!svgToPng(absSource, sourcePng, 1024)) {
        error('SVG → PNG 转换失败。请安装 rsvg-convert: brew install librsvg')
      }
    } else {
      fs.copyFileSync(absSource, sourcePng)
    }
  } else if (fs.existsSync(sourcePng)) {
    log(`使用已有 PNG: ${sourcePng}`)
  } else if (fs.existsSync(DEFAULT_SVG)) {
    log(`从默认 SVG 转换: ${DEFAULT_SVG}`)
    if (!svgToPng(DEFAULT_SVG, sourcePng, 1024)) {
      error('SVG → PNG 转换失败。请安装 rsvg-convert (brew install librsvg) 或手动提供 build/icon.png')
    }
  } else {
    error('未找到图标源文件。请提供 build/icon.png 或 build/icon.svg')
  }

  if (!fs.existsSync(sourcePng)) {
    error(`PNG 文件不存在: ${sourcePng}`)
  }

  log(`源 PNG: ${sourcePng}`)

  // 在 macOS 上生成 .icns
  if (process.platform === 'darwin') {
    try {
      generateIcns(sourcePng)
    } catch (e) {
      log(`⚠️  .icns 生成失败: ${e.message}`)
    }
  }

  // 生成 .ico
  generateIco(sourcePng)

  log('🎉 图标生成完成！')
  log('')
  log('自定义图标方法:')
  log('  1. 替换 build/icon.png (推荐 1024x1024 正方形 PNG)')
  log('  2. 重新运行: node scripts/generate-icons.js')
  log('  或直接指定源文件: node scripts/generate-icons.js /path/to/your-icon.png')
}

main()
