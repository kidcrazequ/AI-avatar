#!/usr/bin/env node
/**
 * scripts/retrofit-skills.ts
 *
 * 一次性回填脚本：把 templates/skills/ 下的 .md 文件 拷贝到 avatars/<id>/skills/ 下。
 * 已存在的技能文件不会被覆盖（尊重用户自定义）。
 *
 * 使用：
 *   npx tsx scripts/retrofit-skills.ts
 *   # 或 npm run retrofit:skills
 *
 * 幂等：重复运行安全，只会把缺失的技能加进去。
 *
 * @author zhi.qu
 * @date 2026-04-13
 */

import fs from 'fs'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
const TEMPLATES_SKILLS_DIR = path.join(REPO_ROOT, 'templates', 'skills')
const AVATARS_DIR = path.join(REPO_ROOT, 'avatars')

function main(): void {
  if (!fs.existsSync(TEMPLATES_SKILLS_DIR)) {
    console.error(`[retrofit] templates/skills/ 不存在: ${TEMPLATES_SKILLS_DIR}`)
    process.exit(1)
  }
  if (!fs.existsSync(AVATARS_DIR)) {
    console.error(`[retrofit] avatars/ 不存在: ${AVATARS_DIR}`)
    process.exit(1)
  }

  const templateFiles = fs
    .readdirSync(TEMPLATES_SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => e.name)

  if (templateFiles.length === 0) {
    console.log('[retrofit] templates/skills/ 为空，无需回填')
    return
  }

  const avatars = fs
    .readdirSync(AVATARS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)

  if (avatars.length === 0) {
    console.log('[retrofit] 没有任何分身，跳过')
    return
  }

  console.log(`[retrofit] 发现 ${templateFiles.length} 个模板技能，${avatars.length} 个分身`)

  let totalInstalled = 0
  for (const avatarId of avatars) {
    const skillsDir = path.join(AVATARS_DIR, avatarId, 'skills')
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true })
    }

    const installed: string[] = []
    for (const fileName of templateFiles) {
      const destPath = path.join(skillsDir, fileName)
      if (fs.existsSync(destPath)) {
        continue // 不覆盖已有
      }
      const content = fs.readFileSync(path.join(TEMPLATES_SKILLS_DIR, fileName), 'utf-8')
      fs.writeFileSync(destPath, content, 'utf-8')
      installed.push(fileName)
      totalInstalled++
    }

    if (installed.length > 0) {
      console.log(`  ✓ ${avatarId}: 安装 ${installed.join(', ')}`)
    } else {
      console.log(`  · ${avatarId}: 已是最新，跳过`)
    }
  }

  console.log(`[retrofit] 完成，共安装 ${totalInstalled} 个技能文件`)
}

main()
