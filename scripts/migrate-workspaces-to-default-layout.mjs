#!/usr/bin/env node
/**
 * 一次性迁移：将历史扁平工作区 workspaces/<convId>/ 移入 workspaces/default/<convId>/。
 *
 * 用法：在仓库根目录执行（请先退出 Soul 桌面端）
 *   node scripts/migrate-workspaces-to-default-layout.mjs [/path/to/avatars]
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'fs'
import path from 'path'

const avatarsRoot = process.argv[2] || path.join(process.cwd(), 'avatars')

if (!fs.existsSync(avatarsRoot)) {
  console.error('avatars 目录不存在:', avatarsRoot)
  process.exit(1)
}

const DEFAULT = 'default'

for (const ent of fs.readdirSync(avatarsRoot, { withFileTypes: true })) {
  if (!ent.isDirectory() || ent.name.startsWith('.')) continue
  const ws = path.join(avatarsRoot, ent.name, 'workspaces')
  if (!fs.existsSync(ws)) continue
  const defaultDir = path.join(ws, DEFAULT)
  fs.mkdirSync(defaultDir, { recursive: true })
  const children = fs.readdirSync(ws, { withFileTypes: true })
  for (const ch of children) {
    const full = path.join(ws, ch.name)
    if (ch.name === DEFAULT) continue
    if (!ch.isDirectory()) continue
    const target = path.join(defaultDir, ch.name)
    if (fs.existsSync(target)) {
      console.warn('[skip] 目标已存在', target)
      continue
    }
    fs.renameSync(full, target)
    console.log('[ok]', full, '->', target)
  }
}

console.log('完成。请在应用内确认会话仍归属 project default。')
