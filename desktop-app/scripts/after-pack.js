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

  // --- 交叉编译：替换 @vscode/ripgrep 二进制（macOS → Windows）---
  // @vscode/ripgrep 1.15.x 在 postinstall 时只下载“构建平台”的 bin/rg（这里是 darwin），
  // 没有 win 的 rg.exe。运行期 rgPath 在 win32 上指向 bin/rg.exe，缺失会导致知识库 grep
  // 找不到 bundle 的 ripgrep（虽有 Node 兜底，但拿不到 ripgrep 的速度）。
  // 这里从 microsoft/ripgrep-prebuilt 下载与已装 @vscode/ripgrep 匹配版本的 win64 zip，
  // 解出 rg.exe 放到解包目录，并清理无用的 darwin 二进制。
  //
  // 版本来源：读取已装 @vscode/ripgrep/lib/postinstall.js 里的 VERSION 常量，避免硬编码漂移。
  // 升级 @vscode/ripgrep 时无需改这里；若上游改了 zip 命名规则再调整 assetName。
  if (process.platform === 'darwin' && targetPlatform === 'win32') {
    const ripgrepDir = path.join(
      context.appOutDir,
      'resources/app.asar.unpacked/node_modules/@vscode/ripgrep'
    )
    if (fs.existsSync(ripgrepDir)) {
      const postinstallJs = path.join(
        context.packager.projectDir,
        'node_modules/@vscode/ripgrep/lib/postinstall.js'
      )
      const versionMatch = fs.readFileSync(postinstallJs, 'utf-8').match(/const VERSION = '([^']+)'/)
      if (!versionMatch) {
        throw new Error(`afterPack: 无法从 ${postinstallJs} 解析 ripgrep VERSION 常量`)
      }
      const rgVersion = versionMatch[1]
      const assetName = `ripgrep-${rgVersion}-x86_64-pc-windows-msvc.zip`
      const zipUrl = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${rgVersion}/${assetName}`
      console.log(`  • afterPack: 为 win32 下载 ripgrep prebuild (${rgVersion})`)
      const tmpDir = path.join(path.dirname(context.appOutDir), '.tmp-ripgrep-win32')
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        fs.mkdirSync(tmpDir, { recursive: true })
        const zipPath = path.join(tmpDir, assetName)
        execSync(
          `curl -fL --connect-timeout 10 --retry 2 -o "${zipPath}" "${zipUrl}"`,
          { stdio: 'inherit' }
        )
        // -j 扁平解压，-o 覆盖；只取 rg.exe
        execSync(`unzip -j -o "${zipPath}" "rg.exe" -d "${tmpDir}"`, { stdio: 'inherit' })
        const srcExe = path.join(tmpDir, 'rg.exe')
        const dstExe = path.join(ripgrepDir, 'bin/rg.exe')
        if (!fs.existsSync(srcExe)) {
          throw new Error(`zip 内未找到 rg.exe：${zipUrl}`)
        }
        fs.copyFileSync(srcExe, dstExe)
        // 清理随包带来的 darwin 二进制（win 运行期只认 rg.exe），节省体积
        const darwinRg = path.join(ripgrepDir, 'bin/rg')
        if (fs.existsSync(darwinRg)) fs.rmSync(darwinRg, { force: true })
        const fileInfo = execSync(`file "${dstExe}"`).toString()
        console.log(`  • afterPack: ${fileInfo.trim()}`)
      } catch (e) {
        console.error(`  • afterPack: ripgrep prebuild 替换失败:`, e.message)
        throw e
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    } else {
      console.warn(`  • afterPack: @vscode/ripgrep 目录不存在，跳过 (${ripgrepDir})`)
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
