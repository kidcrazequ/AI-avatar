/**
 * electron-builder afterSign 钩子
 * macOS 交叉编译 Windows 时，系统会给生成的 .exe 文件添加 com.apple.provenance 属性，
 * 导致后续 7zip 压缩步骤 "Operation not permitted"。
 * 此钩子在签名后清除整个 release 目录的 quarantine 属性。
 * @author zhi.qu
 * @date 2026-04-03
 */

const { execSync } = require('child_process')
const path = require('path')

exports.default = async function afterSign(context) {
  if (process.platform !== 'darwin') return

  const dirs = [
    context.appOutDir,
    path.join(context.outDir, 'win-unpacked'),
  ]

  for (const dir of dirs) {
    try {
      execSync(`xattr -cr "${dir}" 2>/dev/null`, { stdio: 'ignore' })
    } catch {}
  }
}
