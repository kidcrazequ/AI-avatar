/**
 * normalize-knowledge-filenames.ts — 一次性脚本：规整知识库 .md 文件名
 *
 * 浏览器下载同名文件时自动追加 `_1_`、`_2_`、`__2_` 等去重后缀，
 * 导入知识库后文件名噪声影响 grep / 引用可读性。
 * 本脚本识别并移除这些噪声后缀，同步更新所有引用点。
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/normalize-knowledge-filenames.ts            # dry-run（默认）
 *   npx tsx scripts/normalize-knowledge-filenames.ts --apply     # 落盘执行
 *
 * @author zhi.qu
 * @date 2026-05-02
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

/* ------------------------------------------------------------------ */
/*  配置                                                               */
/* ------------------------------------------------------------------ */

const SOUL_ROOT = path.resolve(__dirname, '../..')
const APPLY = process.argv.includes('--apply')

/* ------------------------------------------------------------------ */
/*  规整规则                                                           */
/* ------------------------------------------------------------------ */

/**
 * 对文件名（不含 .md 扩展名的 stem 部分）应用规整规则，返回清洗后的 stem。
 *
 * 规则优先级（从高到低）：
 * 1. 移除末尾下载去重后缀 `_N_`（如 `报告_1_` → `报告`）
 * 2. 移除末尾 `__N_` 变体（如 `图纸__2_` → `图纸`）
 * 3. 折叠连续多个下划线为单个（如 `a___b` → `a_b`）
 * 4. 移除尾部多余下划线（如 `报告_` → `报告`）
 */
function normalizeStem(stem: string): string {
  let s = stem

  // 规则 1：移除末尾双下划线去重后缀 __N_（如 `图纸__2_` → `图纸`）
  s = s.replace(/__(\d{1,2})_$/, '')

  // 规则 2：移除末尾单下划线去重后缀 _N_（如 `报告_1_` → `报告`）
  // 仅匹配数字 1-9（浏览器下载去重不会产生 0 或 10+），
  // 避免误匹配日期尾部（如 `_24_10_30_` 中的 `_30_` 不会命中）
  s = s.replace(/_([1-9])_$/, '')

  // 规则 3：折叠连续 3+ 下划线为单个（如 `a___b` → `a_b`）
  s = s.replace(/_{3,}/g, '_')

  // 规则 4：移除尾部多余下划线（如 `报告_` → `报告`）
  s = s.replace(/_+$/, '')

  return s
}

/**
 * 对完整文件名（含扩展名）应用规整。
 * 返回 null 表示无需改名。
 */
function normalizeFilename(filename: string): string | null {
  const ext = path.extname(filename)
  const stem = filename.slice(0, -ext.length)
  const newStem = normalizeStem(stem)
  if (newStem === stem) return null
  return newStem + ext
}

/* ------------------------------------------------------------------ */
/*  引用同步：_index JSON 文件                                         */
/* ------------------------------------------------------------------ */

/**
 * 更新 _index/ 下的 JSON 文件（tokens.json / hashes.json / contexts.json / embeddings.json）。
 * key 格式为 `filename.md::section`，需替换 filename 前缀。
 */
function updateIndexJson(
  jsonPath: string,
  renameMap: Map<string, string>,
): { updated: boolean; keysChanged: number } {
  if (!fs.existsSync(jsonPath)) return { updated: false, keysChanged: 0 }

  const raw = fs.readFileSync(jsonPath, 'utf-8')
  const data = JSON.parse(raw) as Record<string, unknown>
  const newData: Record<string, unknown> = {}
  let keysChanged = 0

  for (const [key, value] of Object.entries(data)) {
    const sepIdx = key.indexOf('::')
    if (sepIdx === -1) {
      newData[key] = value
      continue
    }
    const filenamePart = key.slice(0, sepIdx)
    const rest = key.slice(sepIdx)
    const newName = renameMap.get(filenamePart)
    if (newName) {
      newData[newName + rest] = value
      keysChanged++
    } else {
      newData[key] = value
    }
  }

  if (keysChanged === 0) return { updated: false, keysChanged: 0 }

  const newRaw = JSON.stringify(newData, null, 2) + '\n'
  return { updated: true, keysChanged }
}

function applyIndexJson(
  jsonPath: string,
  renameMap: Map<string, string>,
): number {
  const { updated, keysChanged } = updateIndexJson(jsonPath, renameMap)
  if (!updated) return 0
  const raw = fs.readFileSync(jsonPath, 'utf-8')
  const data = JSON.parse(raw) as Record<string, unknown>
  const newData: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const sepIdx = key.indexOf('::')
    if (sepIdx === -1) { newData[key] = value; continue }
    const filenamePart = key.slice(0, sepIdx)
    const rest = key.slice(sepIdx)
    const newName = renameMap.get(filenamePart)
    newData[newName ? newName + rest : key] = value
  }
  fs.writeFileSync(jsonPath, JSON.stringify(newData, null, 2) + '\n', 'utf-8')
  return keysChanged
}

/* ------------------------------------------------------------------ */
/*  引用同步：question-bank JSON 文件                                   */
/* ------------------------------------------------------------------ */

function updateQuestionBankJson(
  jsonPath: string,
  renameMap: Map<string, string>,
): { updated: boolean; fieldsChanged: number } {
  if (!fs.existsSync(jsonPath)) return { updated: false, fieldsChanged: 0 }

  const raw = fs.readFileSync(jsonPath, 'utf-8')
  let content = raw
  let fieldsChanged = 0

  for (const [oldName, newName] of renameMap) {
    const oldEscaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(oldEscaped, 'g')
    const matches = content.match(re)
    if (matches) {
      fieldsChanged += matches.length
      content = content.replace(re, newName)
    }
  }

  if (fieldsChanged === 0) return { updated: false, fieldsChanged: 0 }
  return { updated: true, fieldsChanged }
}

function applyQuestionBankJson(
  jsonPath: string,
  renameMap: Map<string, string>,
): number {
  if (!fs.existsSync(jsonPath)) return 0

  let content = fs.readFileSync(jsonPath, 'utf-8')
  let total = 0

  for (const [oldName, newName] of renameMap) {
    const oldEscaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(oldEscaped, 'g')
    const matches = content.match(re)
    if (matches) {
      total += matches.length
      content = content.replace(re, newName)
    }
  }

  if (total > 0) {
    fs.writeFileSync(jsonPath, content, 'utf-8')
  }
  return total
}

/* ------------------------------------------------------------------ */
/*  引用同步：_excel JSON 文件                                         */
/* ------------------------------------------------------------------ */

function findExcelJsonFiles(
  excelDir: string,
  renameMap: Map<string, string>,
): Map<string, string> {
  const result = new Map<string, string>()
  if (!fs.existsSync(excelDir)) return result

  for (const [oldMdName, newMdName] of renameMap) {
    const oldJsonName = oldMdName.replace(/\.md$/, '.json')
    const newJsonName = newMdName.replace(/\.md$/, '.json')
    const oldPath = path.join(excelDir, oldJsonName)
    if (fs.existsSync(oldPath)) {
      result.set(oldJsonName, newJsonName)
    }
  }
  return result
}

/* ------------------------------------------------------------------ */
/*  碰撞检测                                                           */
/* ------------------------------------------------------------------ */

function detectCollisions(
  knDir: string,
  renameMap: Map<string, string>,
): string[] {
  const existingFiles = new Set(
    fs.readdirSync(knDir).filter(f => f.endsWith('.md')),
  )
  const collisions: string[] = []

  const targetNames = new Map<string, string[]>()
  for (const [oldName, newName] of renameMap) {
    const list = targetNames.get(newName) ?? []
    list.push(oldName)
    targetNames.set(newName, list)
  }

  for (const [newName, sources] of targetNames) {
    if (sources.length > 1) {
      collisions.push(`多→一冲突: ${sources.join(', ')} → ${newName}`)
    }
    if (existingFiles.has(newName) && !renameMap.has(newName)) {
      collisions.push(`已有同名文件: ${sources[0]} → ${newName}（已存在且不在重命名列表中）`)
    }
  }

  return collisions
}

/* ------------------------------------------------------------------ */
/*  主流程                                                             */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`🔍 模式: ${APPLY ? '--apply（落盘执行）' : '--dry-run（仅预览）'}`)

  const knowledgeDirs = fs.readdirSync(path.join(SOUL_ROOT, 'avatars'), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      avatarName: d.name,
      knDir: path.join(SOUL_ROOT, 'avatars', d.name, 'knowledge'),
    }))
    .filter(({ knDir }) => fs.existsSync(knDir))

  for (const { avatarName, knDir } of knowledgeDirs) {
    console.log(`\n📁 分身: ${avatarName}`)
    console.log(`   目录: ${path.relative(SOUL_ROOT, knDir)}`)

    const mdFiles = fs.readdirSync(knDir).filter(f => f.endsWith('.md'))
    const renameMap = new Map<string, string>()

    for (const filename of mdFiles) {
      const newName = normalizeFilename(filename)
      if (newName) {
        renameMap.set(filename, newName)
      }
    }

    if (renameMap.size === 0) {
      console.log('   ✅ 所有文件名已规整，无需重命名')
      continue
    }

    /* ---- 碰撞检测 ---- */
    const collisions = detectCollisions(knDir, renameMap)
    if (collisions.length > 0) {
      console.log('\n   ⚠️  检测到碰撞，以下重命名被跳过:')
      for (const c of collisions) {
        console.log(`      ${c}`)
      }
      for (const c of collisions) {
        const match = c.match(/^多→一冲突: (.+) → /)
        if (match) {
          for (const src of match[1].split(', ')) {
            renameMap.delete(src)
          }
        }
        const match2 = c.match(/^已有同名文件: (.+) → /)
        if (match2) {
          renameMap.delete(match2[1])
        }
      }
    }

    if (renameMap.size === 0) {
      console.log('   ✅ 扣除碰撞后无可安全重命名的文件')
      continue
    }

    /* ---- 输出重命名映射表 ---- */
    console.log(`\n   📋 重命名映射表（${renameMap.size} 个文件）:`)
    for (const [oldName, newName] of renameMap) {
      console.log(`      ${oldName}`)
      console.log(`    → ${newName}`)
      console.log()
    }

    /* ---- 引用影响分析 ---- */
    const indexDir = path.join(knDir, '_index')
    const indexFiles = ['tokens.json', 'hashes.json', 'contexts.json', 'embeddings.json']
    let totalIndexKeys = 0
    for (const f of indexFiles) {
      const { keysChanged } = updateIndexJson(path.join(indexDir, f), renameMap)
      totalIndexKeys += keysChanged
    }
    if (totalIndexKeys > 0) {
      console.log(`   📊 _index/ JSON: ${totalIndexKeys} 个 key 将被更新`)
    }

    const excelDir = path.join(knDir, '_excel')
    const excelRenameMap = findExcelJsonFiles(excelDir, renameMap)
    if (excelRenameMap.size > 0) {
      console.log(`   📊 _excel/ JSON: ${excelRenameMap.size} 个文件将被重命名`)
      for (const [oldJ, newJ] of excelRenameMap) {
        console.log(`      ${oldJ} → ${newJ}`)
      }
    }

    const testsDir = path.join(SOUL_ROOT, 'avatars', avatarName, 'tests', 'generated')
    const qbFiles = ['question-bank.json', 'question-bank.full.json']
    let totalQbFields = 0
    for (const f of qbFiles) {
      const qbPath = path.join(testsDir, f)
      const { fieldsChanged } = updateQuestionBankJson(qbPath, renameMap)
      totalQbFields += fieldsChanged
    }
    if (totalQbFields > 0) {
      console.log(`   📊 question-bank: ${totalQbFields} 处引用将被更新`)
    }

    /* ---- 执行 ---- */
    if (!APPLY) continue

    console.log('\n   🔧 正在执行重命名...')

    let renamedCount = 0
    for (const [oldName, newName] of renameMap) {
      const oldPath = path.join(knDir, oldName)
      const newPath = path.join(knDir, newName)
      fs.renameSync(oldPath, newPath)
      renamedCount++
    }
    console.log(`      .md 文件: ${renamedCount} 个已重命名`)

    for (const f of indexFiles) {
      const n = applyIndexJson(path.join(indexDir, f), renameMap)
      if (n > 0) console.log(`      _index/${f}: ${n} 个 key 已更新`)
    }

    for (const [oldJ, newJ] of excelRenameMap) {
      fs.renameSync(path.join(excelDir, oldJ), path.join(excelDir, newJ))
    }
    if (excelRenameMap.size > 0) {
      console.log(`      _excel/ JSON: ${excelRenameMap.size} 个已重命名`)
    }

    for (const f of qbFiles) {
      const n = applyQuestionBankJson(path.join(testsDir, f), renameMap)
      if (n > 0) console.log(`      ${f}: ${n} 处引用已更新`)
    }
  }

  /* ---- 汇总 ---- */
  console.log('\n' + '='.repeat(60))

  if (!APPLY) {
    console.log('💡 这是 dry-run 模式，不会修改任何文件。')
    console.log('   确认无误后运行: npx tsx scripts/normalize-knowledge-filenames.ts --apply')
  } else {
    try {
      const diff = execSync('git diff --stat', { cwd: SOUL_ROOT, encoding: 'utf-8' })
      console.log('\n📋 git diff --stat:')
      console.log(diff)
    } catch {
      console.log('\n⚠️  无法执行 git diff（可能不在 git 仓库内）')
    }
    console.log('💡 请 review 改动后 git add + commit，或 git checkout -- 撤销')
  }
}

main().catch(err => {
  console.error('脚本执行失败:', err)
  process.exit(1)
})
