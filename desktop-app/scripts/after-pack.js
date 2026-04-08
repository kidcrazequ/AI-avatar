/**
 * electron-builder afterPack 钩子
 * @author zhi.qu
 * @date 2026-04-03
 */
const { execSync } = require('child_process')

exports.default = async function afterPack(context) {
  if (process.platform !== 'darwin') return
  try {
    // 清除 macOS quarantine 扩展属性，避免 7zip 打包时 "Operation not permitted"
    execSync(`xattr -cr "${context.appOutDir}" 2>/dev/null`, { stdio: 'ignore' })
    // 确保所有文件对当前用户可读可写，解决交叉编译 Windows 包时的权限问题
    execSync(`chmod -R u+rw "${context.appOutDir}" 2>/dev/null`, { stdio: 'ignore' })
  } catch {}
}
