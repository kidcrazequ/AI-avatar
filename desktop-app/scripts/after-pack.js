/**
 * electron-builder afterPack 钩子
 * - macOS 交叉编译 Windows 时：
 *   1. 用 prebuild-install 下载 win32 版 better_sqlite3.node 替换
 *   2. 用 GitHub release tarball 下载 win32 版 nodejieba.node 替换（@mapbox/node-pre-gyp 风格）
 * - 清除 macOS quarantine 属性防止 7zip 权限错误
 * @author zhi.qu
 * @date 2026-04-03
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

exports.default = async function afterPack(context) {
  const targetPlatform = context.electronPlatformName // 'win32' | 'darwin' | 'linux'

  // --- 交叉编译：替换 better-sqlite3 原生模块 ---
  if (process.platform === 'darwin' && targetPlatform !== 'darwin') {
    const betterSqliteDir = path.join(
      context.appOutDir,
      'resources/app.asar.unpacked/node_modules/better-sqlite3'
    )
    if (!fs.existsSync(betterSqliteDir)) {
      throw new Error(
        `afterPack: 未找到解包目录 ${betterSqliteDir}。请在 electron-builder.yml 的 asarUnpack 中包含 node_modules/better-sqlite3/**/*`
      )
    }
    const electronVersion = context.packager.config.electronVersion
      || require(path.join(context.packager.projectDir, 'node_modules/electron/package.json')).version
    console.log(`  • afterPack: 为 ${targetPlatform} 下载 better-sqlite3 prebuild (electron ${electronVersion})`)
    try {
      execSync(
        `npx prebuild-install -r electron -t ${electronVersion} --platform ${targetPlatform} --arch x64`,
        { cwd: betterSqliteDir, stdio: 'inherit' }
      )
      const nodeFile = path.join(betterSqliteDir, 'build/Release/better_sqlite3.node')
      const fileInfo = execSync(`file "${nodeFile}"`).toString()
      console.log(`  • afterPack: ${fileInfo.trim()}`)
    } catch (e) {
      console.error(`  • afterPack: better-sqlite3 prebuild 下载失败:`, e.message)
      throw e
    }
  }

  // --- 交叉编译：替换 nodejieba 原生模块（macOS → Windows）---
  // nodejieba 用 @mapbox/node-pre-gyp 分发 prebuild，tarball 命名按 NODE_MODULE_VERSION。
  //
  // 关于 ABI 选择（2026-05-15 纠偏）：
  // nodejieba 3.5.8 是 N-API 模块（导出 napi_register_module_v1），
  // 上游官方只发布了 `node-v127` 系列的 win32 prebuild（对应 Node.js 22 ABI），
  // 没有发布 Electron 41 真正的 ABI 145（`electron-v145` / `node-v145`）prebuild。
  // 但 N-API 跨 ABI 兼容：Electron 41 加载 node-v127 编译产物可以正常 napi_register，
  // 因此这里继续使用 `node-v127`，**这不是 bug 而是 N-API 的设计**。
  // 实测打包出的 `nodejieba.node` 在 win-unpacked 里是 PE32+ x86-64，正常工作。
  //
  // 升级 nodejieba / electron 时检查：
  //   1. 新版本是否仍然是 N-API（看 `objdump -p ... | grep napi_register_module_v1`），
  //      还是变回了原生 NODE_MODULE_VERSION 绑定。
  //   2. GitHub release 是否有更高 node-vXXX 系列；优先选 Electron 当前 ABI 对应的发布。
  if (process.platform === 'darwin' && targetPlatform === 'win32') {
    const nodejiebaDir = path.join(
      context.appOutDir,
      'resources/app.asar.unpacked/node_modules/nodejieba'
    )
    if (fs.existsSync(nodejiebaDir)) {
      const nodejiebaVersion = require(
        path.join(context.packager.projectDir, 'node_modules/nodejieba/package.json')
      ).version
      // nodejieba 3.5.8 上游只发 node-v127 win32 prebuild；N-API 跨 ABI 兼容，Electron 41 (ABI 145) 可加载。
      const nodeAbi = 'node-v127'
      const tarballUrl = `https://github.com/yanyiwu/nodejieba/releases/download/v${nodejiebaVersion}/nodejieba-v${nodejiebaVersion}-${nodeAbi}-win32-x64-unknown.tar.gz`
      console.log(`  • afterPack: 为 win32 下载 nodejieba prebuild (v${nodejiebaVersion}, ${nodeAbi})`)
      const tmpDir = path.join(path.dirname(context.appOutDir), '.tmp-nodejieba-win32')
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        fs.mkdirSync(tmpDir, { recursive: true })
        const tarballPath = path.join(tmpDir, 'nodejieba.tar.gz')
        execSync(
          `curl -fL --connect-timeout 10 --retry 2 -o "${tarballPath}" "${tarballUrl}"`,
          { stdio: 'inherit' }
        )
        execSync(`tar xzf "${tarballPath}" -C "${tmpDir}"`, { stdio: 'inherit' })
        const srcNodeFile = path.join(tmpDir, 'Release/nodejieba.node')
        const dstNodeFile = path.join(nodejiebaDir, 'build/Release/nodejieba.node')
        if (!fs.existsSync(srcNodeFile)) {
          throw new Error(`tarball 内未找到 Release/nodejieba.node：${tarballUrl}`)
        }
        fs.copyFileSync(srcNodeFile, dstNodeFile)
        const fileInfo = execSync(`file "${dstNodeFile}"`).toString()
        console.log(`  • afterPack: ${fileInfo.trim()}`)
      } catch (e) {
        console.error(`  • afterPack: nodejieba prebuild 替换失败:`, e.message)
        throw e
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    } else {
      console.warn(`  • afterPack: nodejieba 目录不存在，跳过 (${nodejiebaDir})`)
    }
  }

  // --- macOS quarantine 清理 ---
  if (process.platform === 'darwin') {
    try {
      execSync(`xattr -cr "${context.appOutDir}" 2>/dev/null`, { stdio: 'ignore' })
      execSync(`chmod -R u+rw "${context.appOutDir}" 2>/dev/null`, { stdio: 'ignore' })
    } catch {}
  }
}
